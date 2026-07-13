/**
 * Story-game 系统提示词模板
 *
 * 核心原则：
 * - 角色性格贴合用户输入的设定
 * - 故事氛围自然流畅
 * - 输出为纯 JSON，无 markdown 包裹
 * - 分为 Architect（生成故事档案）/ Writer（写正文）/ Reviewer（审稿）/ Polish（润色）/ Seeds（下一章方向）五层
 */

// 节奏档位配置
const PACE_META = {
  fast:   { narrativeMax: 120,  triggerEnding: 3, label: '快节奏' },
  normal: { narrativeMax: 200,  triggerEnding: 8, label: '标准节奏' },
  slow:   { narrativeMax: 280, triggerEnding: 15, label: '慢节奏' }
};

// 结局偏好配置
const ENDING_META = {
  he:   { label: 'HE（Happy Ending）' },
  be:   { label: 'BE（Bad Ending）' },
  open: { label: '开放式结局' }
};

// ─────────────────────────────────────────────
// 一、解析器：把 textarea 文本拆成结构化字段
// 用户可按【世界观】【主角】【核心角色】【画风】【必出现】【禁止】分段写，
// 也可以只写一段自由文本，系统会智能解析。
// ─────────────────────────────────────────────

const SECTION_MAP = {
  '世界观':     'worldSetting',
  '主角':       'protagonist',
  '核心角色':   'characters',
  '角色':       'characters',
  '画风':       'styleGuide',
  '必出现':     'mustInclude',
  '禁止':       'forbidden'
};

/**
 * 解析用户输入，提取结构化字段。
 * 支持两种格式：
 * 1. 带【】标记的 section header（如【世界观】）
 * 2. 自由文本（自动归入 protagonist）
 *
 * @param {string} raw - textarea 原始内容
 * @returns {{ worldSetting, protagonist, characters, styleGuide, mustInclude, forbidden }}
 */
function parseUserInput(raw) {
  var result = {
    worldSetting: '',
    protagonist:  '',
    characters:   '',
    styleGuide:   '',
    mustInclude:  [],
    forbidden:    []
  };

  var lines = raw.split('\n');
  var currentKey  = null;
  var currentLines = [];

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var headerMatch = line.match(/^【([^】]+)】\s*$/);
    if (headerMatch) {
      if (currentKey !== null && currentLines.length > 0) {
        var text = currentLines.join('\n').trim();
        if (Array.isArray(result[currentKey])) {
          result[currentKey] = text.split(/[；;]/).map(function(s) { return s.trim(); }).filter(Boolean);
        } else {
          result[currentKey] = text;
        }
      }
      currentKey  = SECTION_MAP[headerMatch[1]] || null;
      currentLines = [];
    } else if (currentKey !== null) {
      currentLines.push(line);
    }
  }
  // 最后一个 section
  if (currentKey !== null && currentLines.length > 0) {
    var text = currentLines.join('\n').trim();
    if (Array.isArray(result[currentKey])) {
      result[currentKey] = text.split(/[；;]/).map(function(s) { return s.trim(); }).filter(Boolean);
    } else {
      result[currentKey] = text;
    }
  }

  // 无任何 section header → 整段当 protagonist
  if (!result.worldSetting && !result.protagonist && !result.characters) {
    result.protagonist = raw.trim();
  }

  return result;
}

// ─────────────────────────────────────────────
// 二、Architect prompt：生成 story bible（10字段）
// ─────────────────────────────────────────────

var ARCHITECT_SYSTEM = `你是一个严格的故事架构师。

用户提供了角色设定和背景信息。你的任务是生成一份完整的《故事档案》，必须包含以下全部10个字段，缺一不可。

【输出格式】
必须输出纯 JSON，不要有 markdown 包裹，不要有额外文字。`;

function buildArchitectPrompt(parsed, charProfiles) {
  var mustIncludeSection = parsed.mustInclude.length
    ? '【必须安排进故事的情节】\n' + parsed.mustInclude.map(function(s, i) { return (i + 1) + '. ' + s; }).join('\n')
    : '【必须安排进故事的情节】（用户未指定，由你根据故事逻辑自行补充2-3个核心场景）';

  var forbiddenSection = parsed.forbidden.length
    ? '【严禁出现的内容】\n' + parsed.forbidden.map(function(s) { return '- ' + s; }).join('\n')
    : '【严禁出现的内容】（用户未指定，默认可出现：校园日常、AI技术讨论、项目合作；禁止：穿越、超自然、无关色情、豪门黑帮）';

  var userContent =
    '【用户提供的信息】\n\n' +
    (parsed.worldSetting ? '世界观：' + parsed.worldSetting + '\n\n' : '') +
    (parsed.protagonist  ? '主角人设：' + parsed.protagonist + '\n\n' : '') +
    (parsed.characters   ? '核心角色：' + parsed.characters + '\n\n' : '') +
    (parsed.styleGuide   ? '画风偏好：' + parsed.styleGuide + '\n\n' : '');

  // 从 RAG charProfiles 提取主角初始值（直接填入 protagonist/heroine schema，防止 Architect 自由发挥）
  var protagonistHeroineSeed = '';
  if (charProfiles && charProfiles.length) {
    protagonistHeroineSeed = charProfiles.map(function(p) {
      return p.name + '：性格=' + p.personality + '；说话方式=' + p.speech +
        '；处事风格=' + p.handlingStyle + '；背景=' + p.backstory +
        '；关键关系=' + p.relationships + '；重要事件=' + p.keyEvents;
    }).join('\n');
  }

  var jsonSchema = JSON.stringify({
    title:        '标题（2-8字，凝练有吸引力）',
    genre:        '题材标签（如：校园/AI创业/慢热甜宠/竞赛逆袭），2-4个标签用 / 分隔',
    logline:      '一句话钩子，15-35字，让人想读下去',
    protagonist:  protagonistHeroineSeed || '主角人设描述（延续用户的设定，可补充性格细节和弱点）',
    heroine:      protagonistHeroineSeed || '女主角/核心配角人设描述（延续用户的设定，可补充反差面和秘密）',
    mainConflict: '核心冲突（1-2句话，明确说明故事的主要矛盾是什么）',
    highlights:   ['看点1（爽点或甜点）', '看点2'],
    openThreads:  ['悬念1', '悬念2（暗线伏笔）'],
    forbidden:    ['禁止项1', '禁止项2'],
    endingHint:   '结局方向提示（1-2句话，暗示结局走向，不直接剧透结局）'
  }, null, 2);

  var promptParts = [
    ARCHITECT_SYSTEM,
    '',
    userContent,
    '',
    mustIncludeSection,
    '',
    forbiddenSection,
    '',
    '【角色保真规则】（必须遵守）',
    '- 用户已指定的角色姓名、性别、身份、性格标签必须原样保留',
    '- 不得替换用户角色，不得推翻核心关系',
    '- 可以补充软肋、反差面、秘密，但不得推翻原设定'
  ];

  // RAG 角色硬约束注入（7维度全量锁定）
  if (charProfiles && charProfiles.length) {
    var charConstraint = '\n【RAG 角色硬约束 — 不得违背】\n';
    charConstraint += '以下角色的全部7个维度（性格、说话方式、处事风格、背景、关键关系、重要事件）是固定约束，在任何场景中都不允许违背：\n';
    charProfiles.forEach(function(p) {
      charConstraint += p.name + '：' +
        '性格=' + p.personality + '；' +
        '说话方式=' + p.speech + '；' +
        '处事风格=' + p.handlingStyle + '；' +
        '背景=' + p.backstory + '；' +
        '关键关系=' + p.relationships + '；' +
        '重要事件=' + p.keyEvents + '\n';
    });
    charConstraint += '\n【特别警告】Architect 输出的 protagonist/heroine 字段必须完全延续上述角色设定，不得自创矛盾内容。';
    promptParts.push(charConstraint);
  }

  promptParts.push('');

  promptParts.push('【输出要求】');
  promptParts.push('请严格按照以下 JSON schema 输出所有字段，不要省略任何一个：');
  promptParts.push('');
  promptParts.push(jsonSchema);

  return promptParts.join('\n');
}

// ─────────────────────────────────────────────
// 三、Writer prompt：生成故事节点正文
// ─────────────────────────────────────────────

var WRITER_SYSTEM = `你是互动小说编剧。

你会收到一份《故事档案》，这是整个故事的根基。每次生成正文时必须严格遵守它，不能偏离。

【角色保真规则】
- 主角人设必须与故事档案中的 protagonist 一致
- 女主角人设必须与故事档案中的 heroine 一致
- 已登记角色不得改名、不得改变核心性格

【剧情控制规则】
- 每场必须推进至少 1 个已有 openThread
- 每场最多新增 1 个悬念
- 角色关系变化必须渐进，不得一场内从陌生变深爱
- 不得引入与故事档案主线无关的新角色
- nextHook 必须承接本场结尾情绪
- 禁止出现故事档案 forbidden 中的任何内容

【输出格式】
必须输出纯 JSON，不要有 markdown 包裹，不要有额外文字。`;

function buildWriterPrompt(bible, history, step, pace, ending, nextHook, synopsis) {
  var meta = PACE_META[pace] || PACE_META.normal;
  var endingLabel = (ENDING_META[ending] || ENDING_META.he).label;

  var historySection = '';
  if (history && history.length > 0) {
    var lines = history.map(function(h, i) {
      var entry = '第' + (i + 1) + '章选项：' + (h.choice || '');
      if (h.narrative) entry += '\n  → 本章摘要：' + h.narrative;
      return entry;
    });
    historySection = '\n【故事历史（请承接上文情节）】\n' + lines.join('\n\n');
  }

  var synopsisSection = synopsis
    ? '\n【当前剧情梗概（请继续推进）】\n' + synopsis + '\n'
    : '';

  var pacingSection =
    '\n【叙事节奏：' + meta.label + '】' +
    '\n- narrative 控制在 ' + meta.narrativeMax + ' 字以内，惜字如金' +
    '\n- choices 直接推进核心情节，不绕弯' +
    (step >= meta.triggerEnding
      ? '\n【强制结局】已进行 ' + step + ' 步（上限 ' + meta.triggerEnding + '），本章必须设置 ending=true 并给出 endingText'
      : '\n- 已进行 ' + step + ' 步（距结局 ' + (meta.triggerEnding - step) + ' 步），情节接近高潮时触发 ending=true');

  var endingSection =
    '\n【结局偏好：' + endingLabel + '】' +
    '\n- HE：情感升华、彼此理解、关系明确，最终走向幸福结局' +
    '\n- BE：遗憾、错失、不可逆转的离别，最终走向悲伤结局' +
    '\n- 开放式：留有余韵，不给明确答案，让玩家自行想象';

  var bibleSection =
    '\n【故事档案】' +
    '\n标题：' + bible.title +
    '\n题材：' + bible.genre +
    '\n主线钩子：' + bible.logline +
    '\n主角：' + bible.protagonist +
    '\n女主角：' + bible.heroine +
    '\n核心冲突：' + bible.mainConflict +
    '\n看点：' + (bible.highlights || []).join('；') +
    '\n已有悬念：' + (bible.openThreads || []).join('；') +
    '\n禁止内容：' + (bible.forbidden || []).join('；') +
    '\n结局方向提示：' + bible.endingHint +
    (nextHook ? ('\n【下一幕方向（必须承接）】：' + nextHook) : '');

  // RAG 角色硬约束注入（双重保险）
  var charContext = '';
  if (bible.charProfiles && bible.charProfiles.length) {
    charContext = '\n【RAG 角色硬约束 — 严格遵守】\n';
    charContext += '以下角色来自原著，以下字段在任何场景中都不允许违背：\n';
    bible.charProfiles.forEach(function(p) {
      charContext += p.name + '：' +
        'personality=' + p.personality + '；' +
        'speech=' + p.speech + '；' +
        'handlingStyle=' + p.handlingStyle + '；' +
        'backstory=' + p.backstory + '；' +
        'relationships=' + p.relationships + '；' +
        'keyEvents=' + p.keyEvents + '\n';
    });
    charContext += '\n写每一句对话时必须符合 speech；写每一个决策时必须符合 handlingStyle。禁止任何角色做出与其 personality/speech/handlingStyle 不符的行为或对话。\n';
  }

  return bibleSection + charContext + historySection + synopsisSection + pacingSection + endingSection +
    '\n\n请生成第 ' + step + ' 个故事节点，遵循以下 JSON 格式输出：\n' +
    JSON.stringify({
      scene:      '场景标题（简洁，2-6字）',
      narrative:  '叙事段落...',
      choices:    ['A. 选项描述', 'B. 选项描述', 'C. 选项描述'],
      ending:     false,
      endingText: '',
      synopsis:   '本章情节一句话摘要（20字内，用于后续章节接续）',
      nextHook:   '下一章悬念钩子（1句话）',
      openThreads:['悬念1（选填，不超过1个）']
    }, null, 2);
}

// ─────────────────────────────────────────────
// 四、Reviewer prompt：审稿检查
// ─────────────────────────────────────────────

var REVIEWER_SYSTEM = `你是资深小说编辑。请严格检查这一章是否存在问题。

逐一检查并输出 JSON，不要有 markdown 包裹：
{
  "result": "APPROVED" | "NEEDS_REVISION",
  "issues": [
    { "id": 1, "location": "开头/中段/结尾", "description": "问题描述", "suggestion": "修改建议" }
  ]
}`;

function buildReviewerPrompt(narrative, bible) {
  return [
    '【待审稿章节】',
    narrative,
    '',
    '【故事档案（用于一致性检查）】',
    'logline：' + bible.logline,
    '主角：' + bible.protagonist,
    '女主角：' + bible.heroine,
    '主线冲突：' + bible.mainConflict,
    '已有悬念：' + (bible.openThreads || []).join('；'),
    '禁止内容：' + (bible.forbidden || []).join('；'),
    '',
    '请逐一检查以下维度：',
    '1. 人设冲突：角色行为是否与档案中 protagonist / heroine 一致？',
    '2. 主线推进：本章是否推进了核心冲突？',
    '3. 冲突密度：是否至少有一个明确的戏剧冲突？',
    '4. 情绪曲线：主角/女主角的情绪是否有起伏变化？',
    '5. 废话检测：是否有空泛描写或无意义的情绪总结句？',
    '6. 钩子质量：结尾是否留下让人想读下一章的悬念？',
    '7. 对话自然度：对话是否像真人说话，还是像 AI 在描述？',
    '8. 细节密度：是否有具体场景细节（环境、动作、微表情）？',
    '9. 禁止项检查：是否出现了 forbidden 中的内容？'
  ].join('\n');
}

// ─────────────────────────────────────────────
// 五、Polish prompt：润色重写
// ─────────────────────────────────────────────

var POLISH_SYSTEM = `你是网文润色专家。请根据审稿意见重写这一章。

【要求】
- 只修改有问题的部分，其余保持不变
- 保持原有 choices 列表不变（只修改 narrative）
- 重写后的 narrative 控制在 N 字以内
- 禁止添加与故事档案不符的内容
- 禁止改变角色核心性格

【输出格式】
必须输出纯 JSON，不要有 markdown 包裹，不要有额外文字。`;

function buildPolishPrompt(draft, issues, bible, pace) {
  var meta = PACE_META[pace] || PACE_META.normal;
  return [
    '【审稿发现的问题】',
    issues.map(function(i) {
      return '问题' + i.id + '（' + i.location + '）：' + i.description + ' → ' + i.suggestion;
    }).join('\n'),
    '',
    '【故事档案（必须遵守）】',
    'logline：' + bible.logline,
    '主角：' + bible.protagonist,
    '女主角：' + bible.heroine,
    '主线冲突：' + bible.mainConflict,
    '已有悬念：' + (bible.openThreads || []).join('；'),
    '',
    '【字数限制】narrative 必须控制在 ' + meta.narrativeMax + ' 字以内。',
    '',
    '【原文】',
    draft.narrative,
    '',
    '请输出重写后的 JSON：\n' + JSON.stringify({
      scene:      draft.scene,
      narrative:  '重写后的叙事段落...',
      choices:    draft.choices,
      ending:     draft.ending,
      endingText: draft.endingText || '',
      synopsis:   (draft.synopsis || (draft.storyStatePatch || {}).synopsis) || '',
      nextHook:   (draft.nextHook || (draft.storyStatePatch || {}).nextHook) || '',
      openThreads:(draft.openThreads || (draft.storyStatePatch || {}).openThreads) || []
    }, null, 2)
  ].join('\n');
}

// ─────────────────────────────────────────────
// 六、Seeds prompt：生成下一章方向候选
// ─────────────────────────────────────────────

var SEEDS_SYSTEM = `你是互动小说编剧。你会收到当前故事状态，请生成3个下一章方向供玩家选择。

【输出格式】
必须输出纯 JSON，不要有 markdown 包裹：
{
  "seeds": [
    { "label": "方向A标签（3-6字）", "description": "方向描述（15-25字）" },
    { "label": "方向B标签（3-6字）", "description": "方向描述（15-25字）" },
    { "label": "方向C标签（3-6字）", "description": "方向描述（15-25字）" }
  ],
  "storyStatePatch": {
    "synopsis": "当前故事进展一句话摘要",
    "openThreads": ["悬念1"],
    "nextHook": "下一章悬念钩子"
  }
}`;

function buildSeedsPrompt(bible, state) {
  var charContext = '';
  if (bible.charProfiles && bible.charProfiles.length) {
    charContext = '\n【角色硬约束（必须遵守）】\n';
    bible.charProfiles.forEach(function(p) {
      charContext += p.name + '：' + p.personality + '；说话方式=' + p.speech + '；处事风格=' + p.handlingStyle + '\n';
    });
  }

  return [
    '【故事档案】',
    'logline：' + bible.logline,
    '题材：' + bible.genre,
    '核心冲突：' + bible.mainConflict,
    '看点：' + (bible.highlights || []).join('；'),
    '',
    '【当前故事状态】',
    '已有悬念：' + ((state && state.openThreads) || []).join('；'),
    '本章结尾方向：' + ((state && state.nextHook) || '（无）'),
    '',
    charContext,
    '【生成要求】',
    '生成3个下一章方向：',
    '方向A：推进核心冲突，偏向主线推进',
    '方向B：探索已有悬念或暗线，偏向悬疑/揭秘',
    '方向C：引入一个小的意外或波折，不影响主线，偏向情绪/关系',
    '',
    '每个方向的 label 是给玩家的简短标签，description 是对下一章走向的一句话描述。'
  ].join('\n');
}

// ─────────────────────────────────────────────
// 七、兼容性：保留原有 SYSTEM_PROMPT / buildUserPrompt
//     供直接调用的 callLLM 使用（降级路径）
// ─────────────────────────────────────────────

const SYSTEM_PROMPT = `你是一个同人文互动故事的叙述者。

用户会提供一段小说文本或角色人设描述。以此为基础，生成一个文游风格的故事节点。

【输出格式】
必须输出纯 JSON，格式如下，不要包含任何 markdown 代码块包裹：

{
  "scene": "场景标题（简洁，2-6字）",
  "narrative": "叙事段落（根据叙事节奏控制字数），营造氛围，推动情节发展。语言风格贴合用户输入的角色设定。",
  "choices": ["A. 选项描述", "B. 选项描述", "C. 选项描述"],
  "ending": false,
  "endingText": ""
}

【规则】
1. scene 简洁有力，如"清晨·卧室"、"雨中·街头"
2. narrative 叙事生动，贴合角色性格，避免流水账
3. choices 三个选项风格各异，给玩家不同体验
4. ending 为 false 时故事继续，为 true 时自然收尾
5. 若 ending=true，endingText 填写结局描述（20字内），choices 可为空数组
6. 首次生成时 ending 必须为 false
7. 输出纯 JSON，不要有 markdown 包裹，不要有额外文字`;

function buildUserPrompt(input, previousChoices, step, pace, ending) {
  var historySection = '';
  if (previousChoices && previousChoices.length > 0) {
    historySection = '\n【已发生的事件】\n' + previousChoices.map(function(c, i) {
      return '第' + (i + 1) + '步：' + c;
    }).join('\n');
  }

  var meta = PACE_META[pace] || PACE_META.normal;
  var endingLabel = (ENDING_META[ending] || ENDING_META.he).label;

  var pacingSection =
    '\n【叙事节奏：' + meta.label + '】' +
    '\n- narrative 控制在 ' + meta.narrativeMax + ' 字以内，惜字如金' +
    '\n- choices 直接推进核心情节，不绕弯' +
    (step >= meta.triggerEnding
      ? '\n【强制结局】已进行 ' + step + ' 步（上限 ' + meta.triggerEnding + '），本章必须设置 ending=true 并给出 endingText'
      : '\n- 已进行 ' + step + ' 步（距结局 ' + (meta.triggerEnding - step) + ' 步），情节接近高潮时触发 ending=true');

  var endingSection =
    '\n【结局偏好：' + endingLabel + '】' +
    '\n- HE：情感升华、彼此理解、关系明确，最终走向幸福结局' +
    '\n- BE：遗憾、错失、不可逆转的离别，最终走向悲伤结局' +
    '\n- 开放式：留有余韵，不给明确答案，让玩家自行想象';

  return '【角色与背景设定】\n' + input + historySection + pacingSection + endingSection +
    '\n\n请生成第 ' + step + ' 个故事节点，遵循上述格式输出。';
}
