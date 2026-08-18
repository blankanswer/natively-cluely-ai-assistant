import React, { useEffect, useState } from 'react';
import { X, Mic, KeyRound, Server, Box, CheckCircle2, AlertCircle } from 'lucide-react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  initialTab?: string;
  initialIsPremium?: boolean | null;
  initialHasNativelyKey?: boolean;
}

type Status = 'idle' | 'saving' | 'testing' | 'success' | 'error';

const inputClass = 'w-full rounded-lg border border-border-subtle bg-bg-input px-3 py-2.5 text-sm text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent-primary';

export default function LiteSettingsOverlay({ isOpen, onClose }: Props) {
  const [endpoint, setEndpoint] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('whisper-1');
  const [hasStoredKey, setHasStoredKey] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    void (async () => {
      try {
        const creds = await window.electronAPI?.getStoredCredentials?.() as any;
        setEndpoint(typeof creds?.openAiSttBaseUrl === 'string' ? creds.openAiSttBaseUrl : '');
        setHasStoredKey(Boolean(creds?.hasSttOpenaiKey));
        // groqSttModel is reused by the Lite REST adapter as the non-secret custom model preference.
        if (typeof creds?.groqSttModel === 'string' && creds.groqSttModel.trim()) {
          setModel(creds.groqSttModel.trim());
        }
      } catch {
        // Keep defaults; settings can still be saved.
      }
    })();
  }, [isOpen]);

  if (!isOpen) return null;

  const save = async () => {
    setStatus('saving');
    setMessage('');
    try {
      await window.electronAPI?.setSttProvider?.('openai');
      await window.electronAPI?.setRecognitionLanguage?.('chinese');
      await window.electronAPI?.setAiResponseLanguage?.('Chinese');
      await window.electronAPI?.setOpenAiSttBaseUrl?.(endpoint.trim());
      await window.electronAPI?.setGroqSttModel?.(model.trim() || 'whisper-1');
      if (apiKey.trim()) {
        const result = await window.electronAPI?.setOpenAiSttApiKey?.(apiKey.trim());
        if (result && result.success === false) throw new Error(result.error || 'API Key 保存失败');
        setHasStoredKey(true);
        setApiKey('');
      }
      setStatus('success');
      setMessage('已保存。新的语音识别会使用自定义 REST 端点。');
    } catch (error: any) {
      setStatus('error');
      setMessage(error?.message || '保存失败');
    }
  };

  const test = async () => {
    setStatus('testing');
    setMessage('');
    try {
      // Persist endpoint/model first so the main-process test path sees the same configuration.
      await window.electronAPI?.setOpenAiSttBaseUrl?.(endpoint.trim());
      await window.electronAPI?.setGroqSttModel?.(model.trim() || 'whisper-1');
      const key = apiKey.trim() || (hasStoredKey ? '__USE_STORED__' : '');
      if (!key) throw new Error('请先输入 API Key。');
      const result = await window.electronAPI?.testSttConnection?.('openai', key);
      if (!result?.success) throw new Error(result?.error || '连接测试失败');
      setStatus('success');
      setMessage('连接测试成功。');
    } catch (error: any) {
      setStatus('error');
      setMessage(error?.message || '连接测试失败');
    }
  };

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/50 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-2xl overflow-hidden rounded-2xl border border-border-subtle bg-bg-elevated shadow-2xl">
        <header className="flex items-center justify-between border-b border-border-subtle px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-text-primary">Natively Lite CN 设置</h2>
            <p className="mt-1 text-xs text-text-tertiary">默认中文 · BYOK · OpenAI-compatible REST STT</p>
          </div>
          <button onClick={onClose} className="rounded-lg p-2 text-text-secondary hover:bg-bg-item-active hover:text-text-primary" aria-label="关闭">
            <X size={18} />
          </button>
        </header>

        <div className="space-y-5 p-5">
          <div className="rounded-xl border border-border-subtle bg-bg-card p-4">
            <div className="mb-4 flex items-start gap-3">
              <div className="rounded-lg bg-bg-item-active p-2 text-accent-primary"><Mic size={18} /></div>
              <div>
                <h3 className="text-sm font-semibold text-text-primary">自定义语音识别 API</h3>
                <p className="mt-1 text-xs leading-5 text-text-tertiary">发送 16 kHz WAV 到 multipart/form-data 接口，不使用 OpenAI Realtime/官方音频 SDK。</p>
              </div>
            </div>

            <div className="space-y-4">
              <label className="block">
                <span className="mb-1.5 flex items-center gap-2 text-xs font-medium text-text-secondary"><Server size={13} /> Endpoint / Base URL</span>
                <input className={inputClass} value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://stt.example.com/v1 或完整 /audio/transcriptions" />
                <span className="mt-1.5 block text-[11px] text-text-tertiary">留空时使用 api.openai.com；支持直接填写完整 transcription 地址。</span>
              </label>

              <label className="block">
                <span className="mb-1.5 flex items-center gap-2 text-xs font-medium text-text-secondary"><KeyRound size={13} /> API Key</span>
                <input className={inputClass} type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={hasStoredKey ? '••••••••••••（已安全保存，留空即保留）' : 'sk-...'} />
                <span className="mt-1.5 block text-[11px] text-text-tertiary">密钥由 Electron safeStorage 加密保存，不写入 localStorage。</span>
              </label>

              <label className="block">
                <span className="mb-1.5 flex items-center gap-2 text-xs font-medium text-text-secondary"><Box size={13} /> Model</span>
                <input className={inputClass} value={model} onChange={(e) => setModel(e.target.value)} placeholder="whisper-1 / faster-whisper-large-v3 / 自定义模型名" />
              </label>

              <div className="rounded-lg border border-border-subtle bg-bg-input px-3 py-2.5 text-xs text-text-secondary">
                识别语言：<strong className="text-text-primary">简体中文 (zh)</strong> · AI 回复：<strong className="text-text-primary">中文</strong>
              </div>
            </div>
          </div>

          {message && (
            <div className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 text-xs ${status === 'error' ? 'border-red-500/20 bg-red-500/10 text-red-400' : 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400'}`}>
              {status === 'error' ? <AlertCircle size={15} className="mt-0.5 shrink-0" /> : <CheckCircle2 size={15} className="mt-0.5 shrink-0" />}
              <span>{message}</span>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button onClick={test} disabled={status === 'testing' || status === 'saving'} className="rounded-lg border border-border-subtle bg-bg-input px-4 py-2 text-sm font-medium text-text-primary hover:bg-bg-item-active disabled:opacity-50">
              {status === 'testing' ? '测试中…' : '测试连接'}
            </button>
            <button onClick={save} disabled={status === 'testing' || status === 'saving'} className="rounded-lg bg-accent-primary px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50">
              {status === 'saving' ? '保存中…' : '保存设置'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
