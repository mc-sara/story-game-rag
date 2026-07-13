/**
 * RAG Agent 前端 Vue 应用 v2
 *
 * 升级：
 * - 文档类型标识（小说 / 技术）
 * - 选中小说后显示角色关系 + 章节摘要
 * - 引用来源标注摘要层 / 正文层
 * - 上传进度显示
 * - 角色关系直接回答来源标注
 */

const { createApp, ref, computed, nextTick, onMounted } = Vue;

const App = {
  setup() {
    // -------------------------------------------------------------------------
    // 状态
    // -------------------------------------------------------------------------
    const messages           = ref([]);
    const inputText         = ref('');
    const isLoading         = ref(false);
    const loadingText       = ref('AI 正在思考...');
    const documents         = ref([]);
    const selectedDocId     = ref(null);
    const showRagPanel      = ref(true);
    const novelCharacters   = ref([]);
    const novelChapterSummaries = ref([]);
    const docAnalysisStatus  = ref({});   // docId → { analyzing, error, ... }
    const completedToasts   = ref(new Set()); // 已弹过"完成"toast 的 docId，防止重复
    const fileInputRef      = ref(null);
    const inputRef          = ref(null);
    const currentSessionId  = ref(localStorage.getItem('rag_session_id') || null);
    const sessions          = ref([]);
    const activeSidebarTab  = ref('docs');

    // -------------------------------------------------------------------------
    // 计算属性
    // -------------------------------------------------------------------------
    const totalChunks = computed(() =>
      documents.value.reduce((sum, d) => sum + (d.chunkCount || 0), 0)
    );
    const summaryChunks = computed(() =>
      documents.value.reduce((sum, d) => sum + ((d.chunkCount || 0) - (d.chapters || 0)), 0)
    );
    const selectedNovel = computed(() =>
      documents.value.find(d => d.id === selectedDocId && d.docType === 'novel') || null
    );

    // -------------------------------------------------------------------------
    // 文档管理
    // -------------------------------------------------------------------------

    async function loadDocuments() {
      try {
        const res = await fetch('/documents');
        documents.value = await res.json();
        // 默认选中最新文档
        if (documents.value.length > 0) {
          const latest = [...documents.value].sort((a, b) => b.uploadedAt - a.uploadedAt)[0];
          await selectDoc(latest);
        }
      } catch (e) {
        showToast('加载文档列表失败', 'error');
      }
    }

    function triggerUpload() {
      fileInputRef.value?.click();
    }

    async function handleFileUpload(e) {
      const file = e.target.files?.[0];
      if (!file) return;
      const ext = file.name.split('.').pop().toLowerCase();

      if (ext === 'pdf') {
        loadingText.value = '正在解析 PDF...';
        isLoading.value = true;
        try {
          const arrayBuffer = await file.arrayBuffer();
          const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
          let text = '';
          for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const content = await page.getTextContent();
            text += content.items.map(item => item.str).join(' ') + '\n\n';
          }
          if (!text.trim()) throw new Error('PDF 无文字内容');

          const res = await fetch('/documents/text', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: file.name, text })
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || '上传失败');

          documents.value.push(data);
          await selectDoc(data);
          showToast(`「${data.name}」入库成功！`);
        } catch (err) {
          showToast(err.message, 'error');
        } finally {
          isLoading.value = false;
          loadingText.value = 'AI 正在思考...';
          if (fileInputRef.value) fileInputRef.value.value = '';
        }
        return;
      }

      // TXT / MD / JSON
      loadingText.value = '正在上传并分析文档...';
      isLoading.value = true;

      const formData = new FormData();
      formData.append('file', file);

      try {
        const res = await fetch('/documents', { method: 'POST', body: formData });
        const data = await res.json();

        if (!res.ok) throw new Error(data.error || '上传失败');

        documents.value.push(data);
        await selectDoc(data);

        const typeLabel = data.docType === 'novel' ? '（小说·已分析角色）' : '（技术文档）';
        showToast(`「${data.name}」入库成功 ${typeLabel}！`);
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        isLoading.value = false;
        loadingText.value = 'AI 正在思考...';
        if (fileInputRef.value) fileInputRef.value.value = '';
      }
    }

    async function selectDoc(doc) {
      selectedDocId.value = doc.id;
      novelCharacters.value = [];
      novelChapterSummaries.value = [];

      if (doc.docType === 'novel') {
        // 轮询分析状态，直到 analyzing = false
        pollAnalysisStatus(doc.id);
        // 如果已有角色/摘要数据，立即加载
        if (!doc.analyzing) {
          await loadNovelMeta(doc.id);
        }
      }
    }

    async function pollAnalysisStatus(docId) {
      try {
        const res = await fetch(`/documents/${docId}/status`);
        if (!res.ok) return;
        const status = await res.json();
        docAnalysisStatus.value = { ...docAnalysisStatus.value, [docId]: status };

        if (status.analyzing) {
          setTimeout(() => pollAnalysisStatus(docId), 3000);
        } else {
          if (status.analysisError) {
            showToast(`文档分析失败: ${status.analysisError}`, 'error');
          } else if (status.charactersCount > 0) {
            if (!completedToasts.value.has(docId)) {
              completedToasts.value.add(docId);
              showToast('文档分析完成！');
              await loadDocuments();
            }
          }
        }
      } catch (_) {}
    }

    async function loadNovelMeta(docId) {
      try {
        const [charRes, sumRes] = await Promise.all([
          fetch(`/documents/${docId}/characters`),
          fetch(`/documents/${docId}/summaries`)
        ]);
        if (charRes.ok) {
          const charData = await charRes.json();
          novelCharacters.value = charData.characters || [];
        }
        if (sumRes.ok) {
          novelChapterSummaries.value = await sumRes.json();
        }
      } catch (_) {}
    }

    async function removeDoc(docId) {
      try {
        const res = await fetch(`/documents/${docId}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('删除失败');
        documents.value = documents.value.filter(d => d.id !== docId);
        if (selectedDocId.value === docId) {
          selectedDocId.value = documents.value[0]?.id || null;
          novelCharacters.value = [];
          novelChapterSummaries.value = [];
        }
        showToast('文档已删除');
      } catch (err) {
        showToast(err.message, 'error');
      }
    }

    async function clearAllDocs() {
      if (!confirm('确定要清空所有文档吗？')) return;
      try {
        await fetch('/documents', { method: 'DELETE' });
        documents.value = [];
        selectedDocId.value = null;
        novelCharacters.value = [];
        novelChapterSummaries.value = [];
        showToast('已清空全部文档');
      } catch (err) {
        showToast(err.message, 'error');
      }
    }

    // -------------------------------------------------------------------------
    // 问答
    // -------------------------------------------------------------------------

    async function sendMessage() {
      const text = inputText.value.trim();
      if (!text || isLoading.value) return;

      messages.value.push({ role: 'user', content: text });
      inputText.value = '';
      await nextTick();
      scrollToBottom();

      isLoading.value = true;
      loadingText.value = '检索相关片段...';

      try {
        await delay(300);
        loadingText.value = 'AI 正在思考...';

        const body = { question: text };
        if (selectedDocId.value) body.docId = selectedDocId.value;
        if (currentSessionId.value) body.sessionId = currentSessionId.value;

        const res = await fetch('/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '请求失败');

        // 保存 sessionId 到 localStorage
        if (data.sessionId) {
          currentSessionId.value = data.sessionId;
          localStorage.setItem('rag_session_id', data.sessionId);
        }

        messages.value.push({
          role: 'assistant',
          content: data.answer,
          answerSource: data.answerSource,
          sources: data.sources || []
        });

        await nextTick();
        scrollToBottom();
      } catch (err) {
        showToast(err.message, 'error');
        messages.value.pop();
      } finally {
        isLoading.value = false;
        loadingText.value = 'AI 正在思考...';
      }
    }

    // -------------------------------------------------------------------------
    // 会话管理
    // -------------------------------------------------------------------------

    async function loadSessions() {
      try {
        const res = await fetch('/sessions');
        sessions.value = await res.json();
      } catch (_) {}
    }

    async function switchToSessionsTab() {
      activeSidebarTab.value = 'sessions';
      await loadSessions();
    }

    async function selectSession(sess) {
      currentSessionId.value = sess.id;
      localStorage.setItem('rag_session_id', sess.id);
      messages.value = [];
      try {
        const res = await fetch(`/sessions/${sess.id}`);
        if (res.ok) {
          const session = await res.json();
          for (const msg of session.messages) {
            messages.value.push({ role: 'user', content: msg.question });
            messages.value.push({
              role: 'assistant',
              content: msg.answer,
              answerSource: msg.answerSource,
              sources: msg.sources || []
            });
          }
          await nextTick();
          scrollToBottom();
        }
      } catch (_) {}
    }

    async function startNewChat() {
      messages.value = [];
      currentSessionId.value = null;
      localStorage.removeItem('rag_session_id');
      await nextTick();
    }

    async function deleteSession(sessionId) {
      if (!confirm('确定删除该会话？')) return;
      try {
        await fetch(`/sessions/${sessionId}`, { method: 'DELETE' });
        sessions.value = sessions.value.filter(s => s.id !== sessionId);
        if (currentSessionId.value === sessionId) {
          messages.value = [];
          currentSessionId.value = null;
          localStorage.removeItem('rag_session_id');
        }
        showToast('会话已删除');
      } catch (_) {
        showToast('删除失败', 'error');
      }
    }

    function formatTime(ts) {
      if (!ts) return '';
      const d = new Date(ts);
      const now = new Date();
      const diff = now - d;
      if (diff < 60000) return '刚刚';
      if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
      if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
      return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
    }

    // -------------------------------------------------------------------------
    // 工具
    // -------------------------------------------------------------------------

    function scrollToBottom() {
      const el = document.getElementById('messages');
      if (el) el.scrollTop = el.scrollHeight;
    }

    function getLayerInfo(sources) {
      const hasSummary = sources.some(s => s.layer === 'summary');
      const hasContent = sources.some(s => s.layer === 'content');
      if (hasSummary && hasContent) return '摘要 + 正文';
      if (hasSummary) return '仅摘要';
      return '仅正文';
    }

    function formatContent(content) {
      if (!content) return '';
      let formatted = escapeHtml(content);
      formatted = formatted.replace(/```(\w*)\n?([\s\S]*?)```/g,
        (_, lang, code) => `<pre><code class="language-${lang}">${code.trim()}</code></pre>`);
      formatted = formatted.replace(/`([^`]+)`/g, '<code>$1</code>');
      formatted = formatted.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      formatted = formatted.replace(/\*([^*]+)\*/g, '<em>$1</em>');
      formatted = formatted.replace(/\n/g, '<br>');
      return formatted;
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    function delay(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }

    function showToast(message, type = 'success') {
      const toast = document.createElement('div');
      toast.style.cssText = `
        position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%);
        padding: 10px 22px; background: ${type === 'error' ? '#ef4444' : 'var(--accent-color)'};
        color: white; border-radius: 8px; font-size: 14px; z-index: 9999;
        animation: fadeIn 0.25s ease; box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        max-width: 90vw; text-align: center;
      `;
      toast.textContent = message;
      document.body.appendChild(toast);
      setTimeout(() => {
        toast.style.animation = 'fadeOut 0.25s ease';
        setTimeout(() => toast.remove(), 250);
      }, 3500);
    }

    function autoResizeTextarea() {
      const el = inputRef.value;
      if (!el) return;
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 200) + 'px';
    }

    async function loadHistoryMessages() {
      if (!currentSessionId.value) return;
      try {
        const res = await fetch(`/sessions/${currentSessionId.value}`);
        if (!res.ok) return;
        const session = await res.json();
        if (session.messages) {
          for (const msg of session.messages) {
            messages.value.push({ role: 'user', content: msg.question });
            messages.value.push({
              role: 'assistant',
              content: msg.answer,
              answerSource: msg.answerSource,
              sources: msg.sources || []
            });
          }
          await nextTick();
          scrollToBottom();
        }
      } catch (_) {}
    }

    onMounted(async () => {
      await loadDocuments();
      await loadHistoryMessages();
      if (inputRef.value) inputRef.value.addEventListener('input', autoResizeTextarea);
    });

    return {
      messages, inputText, isLoading, loadingText,
      documents, selectedDocId, showRagPanel,
      novelCharacters, novelChapterSummaries, docAnalysisStatus,
      totalChunks, summaryChunks, selectedNovel,
      fileInputRef, inputRef,
      sessions, currentSessionId, activeSidebarTab,
      triggerUpload, handleFileUpload, selectDoc,
      removeDoc, clearAllDocs, sendMessage,
      formatContent, getLayerInfo,
      switchToSessionsTab, selectSession, startNewChat, deleteSession, formatTime
    };
  }
};

createApp(App).mount('#app');
