import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  FileCode2,
  FileUp,
  FolderOpen,
  Pencil,
  RefreshCw,
  RotateCcw,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import type { SkillSummary, SkillUploadPayload } from '../types/electron';

const cardClass = 'rounded-xl border border-border-subtle bg-bg-card p-4';
const buttonClass = 'inline-flex items-center gap-1.5 rounded-lg border border-border-subtle bg-bg-input px-3 py-2 text-xs font-medium text-text-secondary hover:bg-bg-elevated hover:text-text-primary disabled:opacity-50';

const readFileAsBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
    reader.onload = () => {
      const bytes = new Uint8Array(reader.result as ArrayBuffer);
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      resolve(btoa(binary));
    };
    reader.readAsArrayBuffer(file);
  });

export const LiteSkillsSettings: React.FC = () => {
  const api = window.electronAPI as any;
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [success, setSuccess] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [editorContent, setEditorContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const builtins = useMemo(() => skills.filter((s) => s.source === 'builtin'), [skills]);
  const custom = useMemo(() => skills.filter((s) => s.source !== 'builtin'), [skills]);

  const loadSkills = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.skillsRefresh?.();
      setSkills(Array.isArray(list) ? list : []);
      setStatus('');
    } catch (error: any) {
      setStatus(error?.message || 'Skills è¯»å–å¤±è´¥ã€‚');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  const openBuiltin = async (skill: SkillSummary) => {
    setStatus('');
    setSuccess('');
    try {
      const result = await api.skillsGetBuiltin?.(skill.id);
      if (!result?.success) throw new Error(result?.error || 'æ— æ³•è¯»å–å†…ç½® Skillã€‚');
      setEditingId(skill.id);
      setEditingName(result.name || skill.name);
      setEditorContent(result.content || '');
    } catch (error: any) {
      setStatus(error?.message || 'æ— æ³•è¯»å–å†…ç½® Skillã€‚');
    }
  };

  const saveBuiltin = async () => {
    if (!editingId) return;
    setSaving(true);
    setStatus('');
    setSuccess('');
    try {
      const result = await api.skillsSaveBuiltin?.(editingId, editorContent);
      if (!result?.success) throw new Error(result?.error || 'ä¿å­˜å¤±è´¥ã€‚');
      setEditorContent(result.content || editorContent);
      setSuccess(`å·²ä¿å­˜ ${result.name || editingName}ã€‚åç»­ /${editingId} è°ƒç”¨ä¼šä½¿ç”¨æ–°å†…å®¹ã€‚`);
      await loadSkills();
    } catch (error: any) {
      setStatus(error?.message || 'ä¿å­˜å¤±è´¥ã€‚');
    } finally {
      setSaving(false);
    }
  };

  const resetBuiltin = async () => {
    if (!editingId) return;
    setSaving(true);
    setStatus('');
    setSuccess('');
    try {
      const result = await api.skillsResetBuiltin?.(editingId);
      if (!result?.success) throw new Error(result?.error || 'æ¢å¤é»˜è®¤å¤±è´¥ã€‚');
      setEditorContent(result.content || '');
      setEditingName(result.name || editingName);
      setSuccess(`å·²æ¢å¤ ${result.name || editingName} çš„å†…ç½®é»˜è®¤å†…å®¹ã€‚`);
      await loadSkills();
    } catch (error: any) {
      setStatus(error?.message || 'æ¢å¤é»˜è®¤å¤±è´¥ã€‚');
    } finally {
      setSaving(false);
    }
  };

  const uploadCustom = async (file: File) => {
    if (!/\.md$/i.test(file.name)) {
      setStatus('è¯·é€‰æ‹© SKILL.md / Markdown æ–‡ä»¶ã€‚');
      return;
    }
    setUploading(true);
    setStatus('');
    setSuccess('');
    try {
      const payload: SkillUploadPayload = {
        kind: 'file',
        filename: file.name,
        contentBase64: await readFileAsBase64(file),
      };
      const outcome = await api.skillsUpload?.(payload, { autoInstall: true });
      if (outcome?.stage !== 'installed') {
        const first = outcome?.errors?.[0];
        throw new Error(first?.message || `å®‰è£…å¤±è´¥ï¼š${outcome?.stage || 'unknown'}`);
      }
      setSuccess(`å·²å®‰è£… ${outcome.preview?.name || file.name}ã€‚`);
      await loadSkills();
    } catch (error: any) {
      setStatus(error?.message || 'Skill ä¸Šä¼ å¤±è´¥ã€‚');
    } finally {
      setUploading(false);
    }
  };

  const deleteCustom = async (skill: SkillSummary) => {
    if (confirmDeleteId !== skill.id) {
      setConfirmDeleteId(skill.id);
      return;
    }
    setStatus('');
    setSuccess('');
    try {
      const result = await api.skillsDelete?.(skill.id);
      if (!result?.success) throw new Error(result?.error || 'åˆ é™¤å¤±è´¥ã€‚');
      setConfirmDeleteId(null);
      setSuccess(`å·²åˆ é™¤ ${skill.name}ã€‚`);
      await loadSkills();
    } catch (error: any) {
      setStatus(error?.message || 'åˆ é™¤å¤±è´¥ã€‚');
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-bold text-text-primary">Skills</h3>
          <p className="mt-1 text-xs leading-5 text-text-secondary">
            å†…ç½® Skill å¯ä»¥ç›´æ¥åœ¨è¿™é‡Œç¼–è¾‘ï¼›è‡ªå®šä¹‰ Skill è¯·åœ¨å¤–éƒ¨ç»´æŠ¤å¥½ SKILL.md åä¸Šä¼ ã€‚Skill ä»æŒ‰ /skill-name æˆ– $skill-name æŒ‰éœ€æ³¨å…¥ï¼Œä¸ä¼šå…¨å±€å¡è¿›æ¯ä¸€è½®ä¸Šä¸‹æ–‡ã€‚
          </p>
        </div>
        <button onClick={() => void loadSkills()} disabled={loading} className={buttonClass}>
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />åˆ·æ–°
        </button>
      </div>

      <section className={cardClass}>
        <div className="mb-3 flex items-center gap-2">
          <FileCode2 size={16} className="text-accent-primary" />
          <div>
            <h4 className="text-sm font-semibold text-text-primary">å†…ç½® Skills</h4>
            <p className="text-[11px] text-text-tertiary">ç¼–è¾‘çš„æ˜¯ userData ä¸­å®é™…ç”Ÿæ•ˆçš„ SKILL.mdï¼›å‡çº§/é‡å¯ä¸ä¼šè¦†ç›–ä½ çš„è‡ªå®šä¹‰å†…å®¹ã€‚</p>
          </div>
        </div>

        <div className="space-y-2">
          {builtins.map((skill) => (
            <div key={skill.id} className="rounded-lg border border-border-subtle bg-bg-input px-3 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-text-primary">{skill.name}</span>
                    <span className="shrink-0 font-mono text-[10px] text-text-tertiary">/{skill.id}</span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-text-secondary">{skill.description}</p>
                </div>
                <button onClick={() => void openBuiltin(skill)} className={buttonClass}>
                  <Pencil size={13} />ç¼–è¾‘
                </button>
              </div>
            </div>
          ))}
          {!loading && builtins.length === 0 && <div className="py-4 text-center text-xs text-text-tertiary">æ²¡æœ‰æ£€æµ‹åˆ°å†…ç½® Skillã€‚</div>}
        </div>
      </section>

      {editingId && (
        <section className={cardClass}>
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h4 className="text-sm font-semibold text-text-primary">ç¼–è¾‘ {editingName}</h4>
              <p className="mt-1 text-[11px] text-text-tertiary">å¯ç¼–è¾‘å®Œæ•´ YAML frontmatter + Markdownï¼›name å¿…é¡»ä¿æŒä¸å˜ï¼Œé¿å… /{editingId} è°ƒç”¨ ID æ¼‚ç§»ã€‚</p>
            </div>
            <button onClick={() => { setEditingId(null); setEditorContent(''); }} className="rounded-lg p-2 text-text-secondary hover:bg-bg-input hover:text-text-primary" aria-label="å…³é—­ç¼–è¾‘å™¨"><X size={15} /></button>
          </div>
          <textarea
            value={editorContent}
            onChange={(e) => setEditorContent(e.target.value)}
            spellCheck={false}
            className="min-h-[360px] max-h-[52vh] w-full resize-y rounded-lg border border-border-subtle bg-bg-input p-3 font-mono text-[12px] leading-5 text-text-primary outline-none focus:border-accent-primary"
          />
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <button onClick={() => void resetBuiltin()} disabled={saving} className={buttonClass}><RotateCcw size={13} />æ¢å¤Íé»˜è®¤</button>
            <button onClick={() => void saveBuiltin()} disabled={saving} className="inline-flex items-center gap-1.5 rounded-lg bg-accent-primary px-4 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"><Save size={13} />{saving ? 'ä¿å­˜ä¸­â€¦' : 'ä¿å­˜'}</button>
          </div>
        </section>
      )}

      <section className={cardClass}>
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h4 className="text-sm font-semibold text-text-primary">è‡ªå®šä¹‰ Skills</h4>
            <p className="mt-1 text-[11px] leading-4 text-text-tertiary">ä¸æä¾›é¡µé¢ç¼–è¾‘å™¨ï¼šè¯·åœ¨ä½ è‡ªå·±çš„ç¼–è¾‘å™¨é‡Œç»´æŠ¤ SKILL.mdï¼Œå†ä¸Šä¼ å®‰è£…ã€‚éœ€è¦æ›´æ–°æ—¶å¯å…ˆåˆ é™¤æ—§ç‰ˆå†ä¸Šä¼ ã€‚</p>
          </div>
          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-accent-primary px-3 py-2 text-xs font-semibold text-white hover:opacity-90">
            <FileUp size={13} />{uploading ? 'ä¸Šä¼ ä¸­â€¦' : 'ä¸Šä¼  SKILL.md'}
            <input
              type="file"
              accept=".md,text/markdown"
              className="hidden"
              disabled={uploading}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.currentTarget.value = '';
                if (file) await uploadCustom(file);
              }}
            />
          </label>
        </div>

        <div className="space-y-2">
          {custom.map((skill) => (
            <div key={skill.id} className="rounded-lg border border-border-subtle bg-bg-input px-3 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-text-primary">{skill.name}</span>
                    <span className="shrink-0 font-mono text-[10px] text-text-text-tertiary">/{skill.id}</span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-text-secondary">{skill.description}</p>
                </div>
                <button
                  onClick={() => void deleteCustom(skill)}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium ${confirmDeleteId === skill.id ? 'bg-red-500 text-white' : 'border border-border-subtle text-text-secondary hover:bg-red-500/10 hover:text-red-400'}`}
                >
                  <Trash2 size={13} />{confirmDeleteId === skill.id ? 'å†æ¬¡ç‚¹å‡»ç¡®è®¤åˆ é™¤' : 'åˆ é™¤'}
                </button>
              </div>
            </div>
          ))}
          {!loading && custom.length === 0 && <div className="py-5 text-center text-xs text-text-tertiary">æš‚å¦—ä»–è‡ªå®šä¹‰ Skillã€‚</div>}
        </div>

        <div className="mt-3 flex justify-end">
          <button onClick={() => void api.skillsOpenFolder?.()} className={buttonClass}><FolderOpen size={13} />æ‰“å¼€ Skills æ–‡ä»¶å¤¹âö°ğ½‰ÕÑÑ½¸ø(€€€€€€€€ğ½‘¥Øø(€€€€€€ğ½Í•Ñ¥½¸ø((€€€€€íÍÕ•ÍÌ€˜˜€ñ‘¥Ø±…ÍÍ9…µ”ô‰™±•à¥Ñ•µÌµÍÑ…ÉĞ…À´ÈÉ½Õ¹‘•µ±œ‰½É‘•È‰½É‘•Èµ•µ•É…±´ÔÀÀ¼ÈÀ‰œµ•µ•É…±´ÔÀÀ¼ÄÀÁà´ÌÁä´ÈÑ•áĞµáÌÑ•áĞµ•µ•É…±´ĞÀÀˆøñ¡•­¥É±”ÈÍ¥é”õìÄÑô±…ÍÍ9…µ”ô‰µĞ´À¸ÔÍ¡É¥¹¬´Àˆ€¼ùíÍÕ•ÍÍôğ½‘¥Øùô(€€€€€íÍÑ…ÑÕÌ€˜˜€ñ‘¥Ø±…ÍÍ9…µ”ô‰É½Õ¹‘•µ±œ‰½É‘•È‰½É‘•ÈµÉ•´ÔÀÀ¼ÈÀ‰œµÉ•´ÔÀÀ¼ÄÀÁà´ÌÁä´ÈÑ•áĞµáÌÑ•áĞµÉ•´ĞÀÀˆùíÍÑ…ÑÕÍôğ½‘¥Øùô(€€€€ğ½‘¥Øø(€€¤ì)ôì()•áÁ½ÉĞ‘•™…Õ±Ğ1¥Ñ•M­¥±±ÍM•ÑÑ¥¹Ìì(