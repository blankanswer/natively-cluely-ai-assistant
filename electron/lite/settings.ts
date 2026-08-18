import { app } from 'electron';
import fs from 'fs';
import path from 'path';

export interface LiteCnSettings {
  sttModel?: string;
}

const filePath = () => path.join(app.getPath('userData'), 'lite-cn-settings.json');

function readSettings(): LiteCnSettings {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeSettings(settings: LiteCnSettings): void {
  const target = filePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

export function getLiteSttModel(): string {
  const model = readSettings().sttModel?.trim();
  return model || 'whisper-1';
}

export function setLiteSttModel(model: string): string {
  const trimmed = String(model ?? '').trim();
  if (trimmed.length > 200) {
    throw new Error('STT model name is too long (max 200 characters).');
  }

  const settings = readSettings();
  settings.sttModel = trimmed || 'whisper-1';
  writeSettings(settings);
  return settings.sttModel;
}
