import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Bot,
  Box,
  CheckCircle2,
  Folder,
  Headphones,
  KeyRound,
  Keyboard,
  Mic,
  Monitor,
  RotateCcw,
  Server,
  SlidersHorizontal,
  Speaker,
  X,
} from 'lucide-react';
import { KeyRecorder } from '../components/ui/KeyRecorder';
import { SkillsSettings } from '../components/settings/SkillsSettings';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  initialTab?: string;
  initialIsPremium?: boolean | null;
  initialHasNativelyKey?: boolean;
}

type Status = 'idle' | 'saving' | 'testing' | 'success' | 'error';
type LiteTab = 'assistant' | 'speech' | 'general' | 'keybinds' | 'skills';
type AudioDevice = { id: string; name: string };
type LiteKeybind = { id: string; label: string; accelerator: string; isGlobal: boolean };

const inputClass = 'w-full rounded-lg border border-border-subtle bg-bg-input px-3 py-2.5 text-sm text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent-primary';
const cardClass = 'rounded-xl border border-border-subtle bg-bg-card p-4';

function tabForInitial(value?: string): LiteTab {
  if (value === 'audio') return 'speech';
  if (value === 'keybinds') return 'keybinds';
  if (value === 'skills') return 'skills';
  if (value === 'ai-providers' || value === 'natively-api') return 'assistant';
  return 'general';
}

function previewTranscriptionEndpoint(value: string): string {
  const raw = value.trim() || 'https://api.openai.com';
  try {
    const url = new URL(raw);
    let pathname = url.pathname.replace(/\/+$/, '');
    if (/\/audio\/transcriptions$/i.test(pathname)) {
      // Complete endpoint.
    } else if (/\/v\d+$/i.test(pathname)) {
      pathname += '/audio/transcriptions';
    } else if (!pathname || pathname === '/') {
      pathname = '/v1/audio/transcriptions';
    } else {
      pathname += '/v1/audio/transcriptions';
    }
    url.pathname = pathname;
    url.hash = '';
    return url.toString();
  } catch {
    return '无效 URL';
  }
}

function normalizeAssistantBaseUrl(value: string): string {
  const raw = value.trim();
  if (!raw) return '';
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Assistant Base URL 仅支持 http:// 或 https://。');
  }
  let pathname = url.pathname.replace(/\/+$/, '');
  pathname = pathname.replace(/\/chat\/completions$/i, '');
  if (!pathname || pathname === '/') pathname = '/v1';
  url.pathname = pathname;
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function previewAssistantEndpoint(value: string): string {
  try {
    const base = normalizeAssistantBaseUrl(value);
    return base ? `${base}/chat/completions` : '尚未配置';
  } catch {
    return '无效 URL';
  }
}

function acceleratorToKeys(accelerator: string): string[] {
  if (!accelerator) return [];
  return accelerator.split('+').map((part) => {
    const p = part.trim();
    if (/^commandorcontrol$/i.test(p)) return 'Ctrl/Cmd';
    if (/^(command|cmd)$/i.test(p)) return '⌘';
    if (/^(control|ctrl)$/i.test(p)) return '⌃';
    if (/^(option|alt)$/i.test(p)) return '⌥';
    if (/^shift$/i.test(p)) return '⇧';
    return p;
  });
}

function recordedKeysToAccelerator(keys: string[]): string {
  return keys.map((key) => {
    if (key === '⌘') return 'Command';
    if (key === '⌃') return 'Control';
    if (key === '⌥') return 'Alt';
    if (key === '⇧') return 'Shift';
    return key;
  }).join('+');
}

export default function LiteSettingsOverlay({ isOpen, onClose, initialTab }: Props) {
  const [activeTab, setActiveTab] = useState<LiteTab>(() => tabForInitial(initialTab));

  const [endpoint, setEndpoint] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('whisper-1');
  const [hasStoredKey, setHasStoredKey] = useState(false);
  const [inputDevices, setInputDevices] = useState<AudioDevice[]>([]);
  const [outputDevices, setOutputDevices] = useState<AudioDevice[]>([]);
  const [selectedInput, setSelectedInput] = useState('');
  const [selectedOutput, setSelectedOutput] = useState('');

  const [assistantBaseUrl, setAssistantBaseUrl] = useState('');
  const [assistantApiKey, setAssistantApiKey] = useState('');
  const [assistantModel, setAssistantModel] = useState('');
  const [assistantHasStoredConfig, setAssistantHasStoredConfig] = useState(false);
  const [currentAssistantLabel, setCurrentAssistantLabel] = useState('未配置');

  const [themeMode, setThemeModeState] = useState<'system' | 'light' | 'dark'>('system');
  const [overlayOpacity, setOverlayOpacityState] = useState(() => {
    const raw = Number(localStorage.getItem('natively_overlay_opacity'));
    return Number.isFinite(raw) && raw >= 0.35 && raw <= 1 ? raw : 0.88;
  });
  const [keybinds, setKeybinds] = useState<LiteKeybind[]>([]);

  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState('');

  const effectiveEndpoint = useMemo(() => previewTranscriptionEndpoint(endpoint), [endpoint]);
  const effectiveAssistantEndpoint = useMemo(() => previewAssistantEndpoint(assistantBaseUrl), [assistantBaseUrl]);

  useEffect(() => {
    if (isOpen) setActiveTab(tabForInitial(initialTab));
  }, [isOpen, initialTab]);

  const loadDevices = async () => {
    try {
      const [inputs, outputs] = await Promise.all([
        window.electronAPI?.getInputDevices?.() ?? Promise.resolve([]),
        window.electronAPI?.getOutputDevices?.() ?? Promise.resolve([]),
      ]);
      setInputDevices((inputs || []) as AudioDevice[]);
      setOutputDevices((outputs || []) as AudioDevice[]);
      const savedInput = localStorage.getItem('preferredInputDeviceId') || '';
      const savedOutput = localStorage.getItem('preferredOutputDeviceId') || '';
      setSelectedInput(savedInput && inputs.some((d: any) => d.id === savedInput) ? savedInput : (inputs[0]?.id || ''));
      setSelectedOutput(savedOutput && outputs.some((d: any) => d.id === savedOutput) ? savedOutput : (outputs[0]?.id || ''));
    } catch {
      setInputDevices([]);
      setOutputDevices([]);
    }
  };

  const loadKeybinds = async () => {
    try {
      const values = await window.electronAPI?.getKeybinds?.();
      setKeybinds(Array.isArray(values) ? values as LiteKeybind[] : []);
    } catch {
      setKeybinds([]);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    setStatus('idle');
    setMessage('');
    void (async () => {
      try {
        const [creds, llm, theme] = await Promise.all([
          window.electronAPI?.getStoredCredentials?.() as any,
          window.electronAPI?.getCurrentLlmConfig?.(),
          window.electronAPI?.getThemeMode?.(),
        ]);
        setEndpoint(typeof creds?.openAiSttBaseUrl === 'string' ? creds.openAiSttBaseUrl : '');
        setHasStoredKey(Boolean(creds?.hasSttOpenaiKey));
        if (typeof creds?.groqSttModel === 'string' && creds.groqSttModel.trim()) setModel(creds.groqSttModel.trim());

        const storedAssistantBase = typeof creds?.litellmBaseURL === 'string' ? creds.litellmBaseURL : '';
        setAssistantBaseUrl(storedAssistantBase);
        setAssistantHasStoredConfig(Boolean(storedAssistantBase));
        const modelId = String((llm as any)?.modelId || (llm as any)?.model || '');
        if (modelId.startsWith('litellm/')) {
          const rawModel = modelId.slice('litellm/'.length);
          setAssistantModel(rawModel);
          setCurrentAssistantLabel(rawModel);
        } else {
          setCurrentAssistantLabel((llm as any)?.displayName || modelId || '未配置');
        }
        if (theme?.mode === 'system' || theme?.mode === 'light' || theme?.mode === 'dark') setThemeModeState(theme.mode);
      } catch {
        // Keep editable defaults.
      }
      await Promise.all([loadDevices(), loadKeybinds()]);
    })();
  }, [isOpen]);

  if (!isOpen) return null;

  const persistAssistantConfig = async () => {
    const baseURL = normalizeAssistantBaseUrl(assistantBaseUrl);
    if (!baseURL) throw new Error('请填写 Assistant Base URL。');
    const rawModel = assistantModel.trim();
    if (!rawModel) throw new Error('请填写 Assistant Model。');
    const modelId = `litellm/${rawModel}`;

    const cfgResult = await window.electronAPI?.setLitellmConfig?.({
      apiKey: assistantApiKey.trim(),
      baseURL,
    });
    if (cfgResult && cfgResult.success === false) throw new Error(cfgResult.error || 'Assistant 配置保存失败');

    const allowResult = await window.electronAPI?.setCloudEnabledModels?.('litellm', [modelId]);
    if (allowResult && allowResult.success === false) throw new Error(allowResult.error || 'Assistant 模型启用失败');

    const modelResult = await window.electronAPI?.setDefaultModel?.(modelId);
    if (modelResult && modelResult.success === false) throw new Error(modelResult.error || 'Assistant 默认模型切换失败');

    setAssistantBaseUrl(baseURL);
    setAssistantHasStoredConfig(true);
    setCurrentAssistantLabel(rawModel);
    return { baseURL, rawModel };
  };

  const saveAssistant = async () => {
    setStatus('saving');
    setMessage('');
    try {
      const { baseURL, rawModel } = await persistAssistantConfig();
      setAssistantApiKey('');
      setStatus('success');
      setMessage(`Assistant 已切换到 ${rawModel} · ${baseURL}/chat/completions`);
    } catch (error: any) {
      setStatus('error');
      setMessage(error?.message || 'Assistant 配置保存失败');
    }
  };

  const testAssistant = async () => {
    setStatus('testing');
    setMessage('');
    try {
      const { baseURL, rawModel } = await persistAssistantConfig();
      // Lite main overrides the existing OpenAI test bridge to probe the exact
      // configured custom Assistant endpoint/model. Reusing this existing bridge
      // avoids adding a second preload surface solely for Lite.
      const result = await window.electronAPI?.testLlmConnection?.('openai', '') as any;
      if (!result?.success) throw new Error(result?.error || 'Assistant 连接测试失败');
      setAssistantApiKey('');
      setStatus('success');
      const latency = typeof result.latencyMs === 'number' ? ` · ${result.latencyMs} ms` : '';
      const preview = result.preview ? ` · 返回：${result.preview}` : '';
      setMessage(`Assistant 测试成功 · ${result.model || rawModel} · ${result.endpoint || `${baseURL}/chat/completions`}${latency}${preview}`);
    } catch (error: any) {
      setStatus('error');
      setMessage(error?.message || 'Assistant 连接测试失败');
    }
  };

  const validateStt = () => {
    if (effectiveEndpoint === '无效 URL') throw new Error('STT Endpoint 必须是完整的 http:// 或 https:// URL。');
    if (!model.trim()) throw new Error('请填写 STT Model。');
  };

  const saveSpeech = async () => {
    setStatus('saving');
    setMessage('');
    try {
      validateStt();
      await window.electronAPI?.setSttProvider?.('openai');
      await window.electronAPI?.setRecognitionLanguage?.('chinese');
      await window.electronAPI?.setAiResponseLanguage?.('Chinese');
      await window.electronAPI?.setOpenAiSttBaseUrl?.(endpoint.trim());
      await window.electronAPI?.setGroqSttModel?.(model.trim());
      if (apiKey.trim()) {
        const result = await window.electronAPI?.setOpenAiSttApiKey?.(apiKey.trim());
        if (result && result.success === false) throw new Error(result.error || 'STT API Key 保存失败');
        setHasStoredKey(true);
        setApiKey('');
      }
      if (selectedInput) localStorage.setItem('preferredInputDeviceId', selectedInput);
      if (selectedOutput) localStorage.setItem('preferredOutputDeviceId', selectedOutput);
      setStatus('success');
      setMessage(`语音设置已保存 · ${effectiveEndpoint} · Model: ${model.trim()}`);
    } catch (error: any) {
      setStatus('error');
      setMessage(error?.message || '保存失败');
    }
  };

  const testSpeech = async () => {
    setStatus('testing');
    setMessage('');
    try {
      validateStt();
      await window.electronAPI?.setOpenAiSttBaseUrl?.(endpoint.trim());
      await window.electronAPI?.setGroqSttModel?.(model.trim());
      const key = apiKey.trim() || (hasStoredKey ? '__USE_STORED__' : '');
      if (!key) throw new Error('请先输入 STT API Key。');
      const result = await window.electronAPI?.testSttConnection?.('openai', key) as any;
      if (!result?.success) throw new Error(result?.error || '连接测试失败');
      setStatus('success');
      setMessage(`STT 测试成功 · ${result.endpoint || effectiveEndpoint} · Model: ${result.model || model.trim()}`);
    } catch (error: any) {
      setStatus('error');
      setMessage(error?.message || '连接测试失败');
    }
  };

  const updateTheme = async (mode: 'system' | 'light' | 'dark') => {
    setThemeModeState(mode);
    try { await window.electronAPI?.setThemeMode?.(mode); } catch { /* reload reconciles */ }
  };

  const updateOpacity = (value: number) => {
    setOverlayOpacityState(value);
    localStorage.setItem('natively_overlay_opacity', String(value));
    void window.electronAPI?.setOverlayOpacity?.(value);
  };

  const saveKeybind = async (binding: LiteKeybind, keys: string[]) => {
    const accelerator = recordedKeysToAccelerator(keys);
    if (!accelerator) return;
    try {
      const result = await window.electronAPI?.setKeybind?.(binding.id, accelerator) as any;
      if (result?.success === false) throw new Error(result.error || '快捷键保存失败');
      await loadKeybinds();
      setStatus('success');
      setMessage(`${binding.label} 已更新为 ${accelerator}`);
    } catch (error: any) {
      setStatus('error');
      setMessage(error?.message || '快捷键保存失败');
    }
  };

  const resetAllKeybinds = async () => {
    try {
      await window.electronAPI?.resetKeybinds?.();
      await loadKeybinds();
      setStatus('success');
      setMessage('快捷键已恢复默认值。');
    } catch (error: any) {
      setStatus('error');
      setMessage(error?.message || '快捷键重置失败');
    }
  };

  const tabs: Array<{ id: LiteTab; label: string; icon: React.ReactNode }> = [
    { id: 'assistant', label: 'Assistant API', icon: <Bot size={15} /> },
    { id: 'speech', label: '语音与音频', icon: <Mic size={15} /> },
    { id: 'general', label: '外观与行为', icon: <SlidersHorizontal size={15} /> },
    { id: 'keybinds', label: '快捷键', icon: <Keyboard size={15} /> },
    { id: 'skills', label: 'Skills', icon: <Folder size={15} /> },
  ];

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/50 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-border-subtle bg-bg-elevated shadow-2xl">
        <header className="flex shrink-0 items-center justify-between border-b border-border-subtle px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-text-primary">Sottura 设置</h2>
            <p className="mt-1 text-xs text-text-tertiary">中文优先 · BYOK · Chat Completions Assistant + REST STT</p>
          </div>
          <button onClick={onClose} className="rounded-lg p-2 text-text-secondary hover:bg-bg-item-active hover:text-text-primary" aria-label="关闭"><X size={18} /></button>
        </header>

        <div className="flex min-h-0 flex-1">
          <aside className="w-48 shrink-0 border-r border-border-subtle bg-bg-card/40 p-3">
            <div className="space-y-1">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => { setActiveTab(tab.id); setMessage(''); setStatus('idle'); }}
                  className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-medium transition-colors ${activeTab === tab.id ? 'bg-bg-item-active text-text-primary' : 'text-text-secondary hover:bg-bg-input hover:text-text-primary'}`}
                >
                  {tab.icon}{tab.label}
                </button>
              ))}
            </div>
            <div className="mt-4 rounded-lg border border-border-subtle bg-bg-input p-3 text-[11px] leading-5 text-text-tertiary">
              Sottura 保留 Assistant、STT、设备、快捷键、外观与 Skills；上游的 Calendar、付费/Trial、云服务与本地模型管理不进入当前设置。
            </div>
          </aside>

          <main className="min-w-0 flex-1 overflow-y-auto p-5">
            {activeTab === 'assistant' && (
              <div className="space-y-4">
                <div className={cardClass}>
                  <div className="mb-4 flex items-start gap-3">
                    <div className="rounded-lg bg-bg-item-active p-2 text-accent-primary"><Bot size={18} /></div>
                    <div>
                      <h3 className="text-sm font-semibold text-text-primary">自定义 Assistant API</h3>
                      <p className="mt-1 text-xs leading-5 text-text-tertiary">本轮只支持 OpenAI-compatible <strong className="text-text-secondary">Chat Completions</strong>。文本与截图/视觉请求都优先走这里选择的模型。</p>
                    </div>
                  </div>
                  <div className="space-y-4">
                    <label className="block">
                      <span className="mb-1.5 flex items-center gap-2 text-xs font-medium text-text-secondary"><Server size={13} /> Base URL</span>
                      <input className={inputClass} value={assistantBaseUrl} onChange={(e) => setAssistantBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" />
                      <span className="mt-1.5 block text-[11px] text-text-tertiary">也可以粘贴完整 <code>/chat/completions</code>；保存时会归一化。</span>
                      <span className={`mt-1.5 block break-all rounded-md px-2 py-1 text-[11px] ${effectiveAssistantEndpoint === '无效 URL' ? 'bg-red-500/10 text-red-400' : 'bg-bg-input text-text-secondary'}`}>实际请求：{effectiveAssistantEndpoint}</span>
                    </label>
                    <label className="block">
                      <span className="mb-1.5 flex items-center gap-2 text-xs font-medium text-text-secondary"><KeyRound size={13} /> API Key</span>
                      <input className={inputClass} type="password" autoComplete="off" value={assistantApiKey} onChange={(e) => setAssistantApiKey(e.target.value)} placeholder={assistantHasStoredConfig ? '••••••••••••（已保存；留空即保留）' : 'sk-...'} />
                    </label>
                    <label className="block">
                      <span className="mb-1.5 flex items-center gap-2 text-xs font-medium text-text-secondary"><Box size={13} /> Model</span>
                      <input className={inputClass} value={assistantModel} onChange={(e) => setAssistantModel(e.target.value)} placeholder="例如 qwen3.7-plus / gpt-4.1-mini / 自定义模型名" />
                    </label>
                    <div className="rounded-lg border border-border-subtle bg-bg-input px-3 py-2.5 text-xs text-text-secondary">当前 Overlay 模型：<strong className="text-text-primary">{currentAssistantLabel}</strong></div>
                    <div className="rounded-lg border border-border-subtle bg-bg-input px-3 py-2.5 text-[11px] leading-5 text-text-tertiary">测试按钮会保存当前输入，再用与会议相同的 Chat Completions transport 发一个真实请求；成功时显示 endpoint、model、延迟与简短返回。</div>
                  </div>
                </div>
                <div className="flex justify-end gap-2">
                  <button onClick={testAssistant} disabled={status === 'testing' || status === 'saving'} className="rounded-lg border border-border-subtle bg-bg-input px-4 py-2 text-sm font-medium text-text-primary hover:bg-bg-item-active disabled:opacity-50">{status === 'testing' ? '测试中…' : '测试 Assistant'}</button>
                  <button onClick={saveAssistant} disabled={status === 'testing' || status === 'saving'} className="rounded-lg bg-accent-primary px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50">{status === 'saving' ? '保存中…' : '保存并切换 Assistant'}</button>
                </div>
              </div>
            )}

            {activeTab === 'speech' && (
              <div className="space-y-4">
                <div className={cardClass}>
                  <div className="mb-4 flex items-start gap-3"><div className="rounded-lg bg-bg-item-active p-2 text-accent-primary"><Mic size={18} /></div><div><h3 className="text-sm font-semibold text-text-primary">OpenAI-compatible 语音识别</h3><p className="mt-1 text-xs leading-5 text-text-tertiary">16 kHz WAV → multipart/form-data；不使用 OpenAI Realtime。</p></div></div>
                  <div className="space-y-4">
                    <label className="block"><span className="mb-1.5 flex items-center gap-2 text-xs font-medium text-text-secondary"><Server size={13} /> Endpoint / Base URL</span><input className={inputClass} value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://stt.example.com/v1 或完整 /audio/transcriptions" /><span className={`mt-1.5 block break-all rounded-md px-2 py-1 text-[11px] ${effectiveEndpoint === '无效 URL' ? 'bg-red-500/10 text-red-400' : 'bg-bg-input text-text-secondary'}`}>实际请求 URL：{effectiveEndpoint}</span></label>
                    <label className="block"><span className="mb-1.5 flex items-center gap-2 text-xs font-medium text-text-secondary"><KeyRound size={13} /> API Key</span><input className={inputClass} type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={hasStoredKey ? '••••••••••••（已安全保存，留空即保留）' : 'sk-...'} /></label>
                    <label className="block"><span className="mb-1.5 flex items-center gap-2 text-xs font-medium text-text-secondary"><Box size={13} /> Model</span><input className={inputClass} value={model} onChange={(e) => setModel(e.target.value)} placeholder="FunAudioLLM/SenseVoiceSmall / whisper-1 / 自定义模型名" /></label>
                  </div>
                </div>
                <div className={cardClass}>
                  <div className="mb-3 flex items-center justify-between"><div className="flex items-center gap-2"><Headphones size={16} className="text-text-secondary" /><h3 className="text-sm font-semibold text-text-primary">录音设备</h3></div><button onClick={() => void loadDevices()} className="text-[11px] text-accent-primary hover:opacity-80">刷新设备</button></div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <label className="block"><span className="mb-1.5 flex items-center gap-2 text-xs text-text-secondary"><Mic size={13} /> 麦克风</span><select className={inputClass} value={selectedInput} onChange={(e) => { setSelectedInput(e.target.value); localStorage.setItem('preferredInputDeviceId', e.target.value); }}>{inputDevices.length === 0 && <option value="">系统默认 / 未检测到</option>}{inputDevices.map((d) => <option key={d.id} value={d.id}>{d.name || d.id}</option>)}</select></label>
                    <label className="block"><span className="mb-1.5 flex items-center gap-2 text-xs text-text-secondary"><Speaker size={13} /> 扬声器 / 系统音频设备</span><select className={inputClass} value={selectedOutput} onChange={(e) => { setSelectedOutput(e.target.value); localStorage.setItem('preferredOutputDeviceId', e.target.value); }}>{outputDevices.length === 0 && <option value="">系统默认 / 未检测到</option>}{outputDevices.map((d) => <option key={d.id} value={d.id}>{d.name || d.id}</option>)}</select></label>
                  </div>
                </div>
                <div className="flex justify-end gap-2"><button onClick={testSpeech} disabled={status === 'testing' || status === 'saving'} className="rounded-lg border border-border-subtle bg-bg-input px-4 py-2 text-sm font-medium text-text-primary hover:bg-bg-item-active disabled:opacity-50">{status === 'testing' ? '测试中…' : '测试 STT'}</button><button onClick={saveSpeech} disabled={status === 'testing' || status === 'saving'} className="rounded-lg bg-accent-primary px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50">{status === 'saving' ? '保存中…' : '保存语音设置'}</button></div>
              </div>
            )}

            {activeTab === 'general' && (
              <div className="space-y-4">
                <div className={cardClass}>
                  <div className="mb-4 flex items-start gap-3"><div className="rounded-lg bg-bg-item-active p-2 text-accent-primary"><Monitor size={18} /></div><div><h3 className="text-sm font-semibold text-text-primary">外观</h3><p className="mt-1 text-xs text-text-tertiary">主题与会议悬浮窗透明度。</p></div></div>
                  <div className="space-y-4">
                    <div><div className="mb-2 text-xs font-medium text-text-secondary">主题</div><div className="flex gap-2">{(['system', 'light', 'dark'] as const).map((mode) => <button key={mode} onClick={() => void updateTheme(mode)} className={`rounded-lg border px-3 py-2 text-xs ${themeMode === mode ? 'border-accent-primary bg-bg-item-active text-text-primary' : 'border-border-subtle bg-bg-input text-text-secondary hover:text-text-primary'}`}>{mode === 'system' ? '跟随系统' : mode === 'light' ? '浅色' : '深色'}</button>)}</div></div>
                    <label className="block"><span className="mb-2 flex items-center justify-between text-xs font-medium text-text-secondary"><span>会议悬浮窗透明度</span><span>{Math.round(overlayOpacity * 100)}%</span></span><input type="range" min="0.35" max="1" step="0.01" value={overlayOpacity} onChange={(e) => updateOpacity(Number(e.target.value))} className="w-full" /></label>
                  </div>
                </div>
                <div className={cardClass}><h3 className="text-sm font-semibold text-text-primary">两个“可见性”概念</h3><div className="mt-3 space-y-2 text-xs leading-5 text-text-secondary"><p>• Launcher 的“可见 / 不可见”只控制<strong className="text-text-primary">能否被截图/屏幕共享捕获</strong>。</p><p>• 会议顶部的 Hide / Show 只控制<strong className="text-text-primary">你自己是否展开会议面板</strong>，与截图保护相互独立。</p><p>• Sottura 的 Hide 会保留顶部 Show 恢复按钮，不会把整个会议窗口从桌面上永久藏掉。</p></div></div>
              </div>
            )}

            {activeTab === 'keybinds' && (
              <div className="space-y-4"><div className={cardClass}><div className="mb-4 flex items-start justify-between gap-3"><div><div className="flex items-center gap-2"><Keyboard size={16} className="text-text-secondary" /><h3 className="text-sm font-semibold text-text-primary">快捷键</h3></div><p className="mt-1 text-xs leading-5 text-text-tertiary">保留全局唤醒/隐藏与回答快捷键，作为悬浮窗恢复通道。</p></div><button onClick={resetAllKeybinds} className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border-subtle bg-bg-input px-2.5 py-1.5 text-[11px] text-text-secondary hover:text-text-primary"><RotateCcw size={12} /> 恢复默认</button></div><div className="divide-y divide-border-subtle">{keybinds.map((binding) => <div key={binding.id} className="flex items-center justify-between gap-4 py-3"><div className="min-w-0"><div className="truncate text-xs font-medium text-text-primary">{binding.label}</div><div className="mt-0.5 text-[10px] text-text-tertiary">{binding.isGlobal ? '全局快捷键' : '应用内快捷键'}</div></div><KeyRecorder currentKeys={acceleratorToKeys(binding.accelerator)} onSave={(keys) => void saveKeybind(binding, keys)} /></div>)}{keybinds.length === 0 && <div className="py-8 text-center text-xs text-text-tertiary">未读取到快捷键。</div>}</div></div></div>
            )}

            {activeTab === 'skills' && <SkillsSettings />}

            {message && (
              <div className={`mt-4 flex items-start gap-2 rounded-lg border px-3 py-2.5 text-xs ${status === 'error' ? 'border-red-500/20 bg-red-500/10 text-red-400' : 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400'}`}>
                {status === 'error' ? <AlertCircle size={15} className="mt-0.5 shrink-0" /> : <CheckCircle2 size={15} className="mt-0.5 shrink-0" />}<span className="break-all">{message}</span>
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
