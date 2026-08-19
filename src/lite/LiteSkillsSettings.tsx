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
      setStatus(error?.message || 'Skills 读取失败。');
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
      if (!result?.success) throw new Error(result?.error || '无法读取内置 Skill。');
      setEditingId(skill.id);
      setEditingName(result.name || skill.name);
      setEditorContent(result.content || '');
    } catch (error: any) {
      setStatus(error?.message || '无法读取内置 Skill。');
    }
  };

  const saveBuiltin = async () => {
    if (!editingId) return;
    setSaving(true);
    setStatus('');
    setSuccess('');
    try {
      const result = await api.skillsSaveBuiltin?.(editingId, editorContent);
      if (!result?.success) throw new Error(result?.error || '保存失败。');
      setEditorContent(result.content || editorContent);
      setSuccess(`已保存 ${result.name || editingName}。后续 /${editingId} 调用会使用新内容。`);
      await loadSkills();
    } catch (error: any) {
      setStatus(error?.message || '保存失败。');
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
      if (!result?.success) throw new Error(result?.error || '恢复默认失败。');
      setEditorContent(result.content || '');
      setEditingName(result.name || editingName);
      setSuccess(`已恢复 ${result.name || editingName} 的内置默认内容。`);
      await loadSkills();
    } catch (error: any) {
      setStatus(error?.message || '恢复默认失败。');
    } finally {
      setSaving(false);
    }
  };

  const uploadCustom = async (file: File) => {
    if (!/\.md$/i.test(file.name)) {
      setStatus('请选择 SKILL.md / Markdown 文件。');
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
        throw new Error(first?.message || `安装失败：${outcome?.stage || 'unknown'}`);
      }
      setSuccess(`已安装 ${outcome.preview?.name || file.name}。`);
      await loadSkills();
    } catch (error: any) {
      setStatus(error?.message || 'Skill 上传失败。');
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
      if (!result?.success) throw new Error(result?.error || '删除失败。');
      setConfirmDeleteId(null);
      setSuccess(`已删除 ${skill.name}。`);
      await loadSkills();
    } catch (error: any) {
      setStatus(error?.message || '删除失败。');
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-bold text-text-primary">Skills</h3>
          <p className="mt-1 text-xs leading-5 text-text-secondary">
            内置 Skill 可以直接在这里编辑；自定义 Skill 请在外部维护好 SKILL.md 后上传。Skill 仍按 /skill-name 或 $skill-name 按需注入，不会全局塞进每一轮上下文。
          </p>
        </div>
        <button onClick={() => void loadSkills()} disabled={loading} className={buttonClass}>
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />刷新
        </button>
      </div>

      <section className={cardClass}>
        <div className="mb-3 flex items-center gap-2">
          <FileCode2 size={16} className="text-accent-primary" />
          <div>
            <h4 className="text-sm font-semibold text-text-primary">内置 Skills</h4>
            <p className="text-[11px] text-text-tertiary">编辑的是 userData 中实际生效的 SKILL.md；升级/重启不会覆盖你的自定义内容。</p>
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
                  <Pencil size={13} />编辑
                </button>
              </div>
            </div>
          ))}
          {!loading && builtins.length === 0 && <div className="py-4 text-center text-xs text-text-tertiary">没有检测到内置 Skill。</div>}
        </div>
      </section>

      {editingId && (
        <section className={cardClass}>
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h4 className="text-sm font-semibold text-text-primary">编辑 {editingName}</h4>
              <p className="mt-1 text-[11px] text-text-tertiary">可编辑完整 YAML frontmatter + Markdown；name 必须保持不变，避免 /{editingId} 调用 ID 漂移。</p>
            </div>
            <button onClick={() => { setEditingId(null); setEditorContent(''); }} className="rounded-lg p-2 text-text-secondary hover:bg-bg-input hover:text-text-primary" aria-label="关闭编辑器"><X size={15} /></button>
          </div>
          <textarea
            value={editorContent}
            onChange={(e) => setEditorContent(e.target.value)}
            spellCheck={false}
            className="min-h-[360px] max-h-[52vh] w-full resize-y rounded-lg border border-border-subtle bg-bg-input p-3 font-mono text-[12px] leading-5 text-text-primary outline-none focus:border-accent-primary"
          />
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <button onClick={() => void resetBuiltin()} disabled={saving} className={buttonClass}><RotateCcw size={13} />恢复默认</button>
            <button onClick={() => void saveBuiltin()} disabled={saving} className="inline-flex items-center gap-1.5 rounded-lg bg-accent-primary px-4 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"><Save size={13} />{saving ? '保存中…' : '保存'}</button>
          </div>
        </section>
      )}

      <section className={cardClass}>
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h4 className="text-sm font-semibold text-text-primary">自定义 Skills</h4>
            <p className="mt-1 text-[11px] leading-4 text-text-tertiary">不提供页面编辑器：请在你自己的编辑器里维护 SKILL.md，再上传安装。需要更新时可先删除旧版再上传。</p>
          </div>
          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-accent-primary px-3 py-2 text-xs font-semibold text-white hover:opacity-90">
            <FileUp size={13} />{uploading ? '上传中…' : '上传 SKILL.md'}
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
                    <span className="shrink-0 font-mono text-[10px] text-text-tertiary">/{skill.id}</span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-text-secondary">{skill.description}</p>
                </div>
                <button
                  onClick={() => void deleteCustom(skill)}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium ${confirmDeleteId === skill.id ? 'bg-red-500 text-white' : 'border border-border-subtle text-text-secondary hover:bg-red-500/10 hover:text-red-400'}`}
                >
                  <Trash2 size={13} />{confirmDeleteId === skill.id ? '再次点击确认删除' : '删除'}
                </button>
              </div>
            </div>
          ))}
          {!loading && custom.length === 0 && <div className="py-5 text-center text-xs text-text-tertiary">暂无自定义 Skill。</div>}
        </div>

        <div className="mt-3 flex justify-end">
          <button onClick={() => void api.skillsOpenFolder?.()} className={buttonClass}><FolderOpen size={13} />打开 Skills 文件夹</button>
        </div>
      </section>

      {success && <div className="flex items-start gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-400"><CheckCircle2 size={14} className="mt-0.5 shrink-0" />{success}</div>}
      {status && <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400">{status}</div>}
    </div>
  );
};

export default LiteSkillsSettings;
