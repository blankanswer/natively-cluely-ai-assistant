import { ipcMain } from 'electron';
import fs from 'fs';
import { SkillsManager } from '../services/SkillsManager';

const MAX_EDITABLE_SKILL_BYTES = 100 * 1024;

function getBuiltin(id: string) {
  const skill = SkillsManager.getInstance().getSkill(id);
  if (!skill) throw new Error(`Skill "${id}" not found.`);
  if (skill.source !== 'builtin') throw new Error('Only built-in skills are editable in Lite settings.');
  if (!skill.filePath) throw new Error('Built-in skill has no on-disk SKILL.md path.');
  return skill;
}

function frontmatterName(content: string): string | null {
  const frontmatter = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter) return null;
  const match = frontmatter[1].match(/^name:\s*(.+?)\s*$/m);
  if (!match) return null;
  return match[1].trim().replace(/^['"]|['"]$/g, '');
}

function readBuiltin(id: string) {
  const skill = getBuiltin(id);
  return {
    success: true,
    id: skill.id,
    name: skill.name,
    description: skill.description,
    content: fs.readFileSync(skill.filePath!, 'utf8'),
  };
}

export function installBuiltinSkillEditorIpc(): void {
  ipcMain.removeHandler('lite:skills:get-builtin');
  ipcMain.handle('lite:skills:get-builtin', async (_event, id: string) => {
    try {
      return readBuiltin(String(id || ''));
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) };
    }
  });

  ipcMain.removeHandler('lite:skills:save-builtin');
  ipcMain.handle('lite:skills:save-builtin', async (_event, id: string, rawContent: string) => {
    const normalizedId = String(id || '');
    try {
      const skill = getBuiltin(normalizedId);
      const content = typeof rawContent === 'string' ? rawContent.replace(/\r\n/g, '\n') : '';
      const bytes = Buffer.byteLength(content, 'utf8');
      if (!content.trim()) throw new Error('SKILL.md cannot be empty.');
      if (bytes > MAX_EDITABLE_SKILL_BYTES) throw new Error('SKILL.md exceeds the 100 KB limit.');

      const declaredName = frontmatterName(content);
      if (!declaredName) throw new Error('SKILL.md must keep valid YAML frontmatter with a name field.');
      if (declaredName !== skill.name) {
        throw new Error(`Built-in skill name must remain "${skill.name}" so its invocation id stays stable.`);
      }

      const previous = fs.readFileSync(skill.filePath!, 'utf8');
      try {
        fs.writeFileSync(skill.filePath!, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
        const reloaded = SkillsManager.getInstance().getSkill(normalizedId);
        if (!reloaded || reloaded.source !== 'builtin') {
          throw new Error('Saved SKILL.md could not be parsed back as the same built-in skill.');
        }
      } catch (error) {
        fs.writeFileSync(skill.filePath!, previous, 'utf8');
        throw error;
      }

      return { ...readBuiltin(normalizedId), saved: true };
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) };
    }
  });

  ipcMain.removeHandler('lite:skills:reset-builtin');
  ipcMain.handle('lite:skills:reset-builtin', async (_event, id: string) => {
    const normalizedId = String(id || '');
    try {
      const skill = getBuiltin(normalizedId);
      fs.rmSync(skill.filePath!, { force: true });
      // listSkills() re-seeds a missing built-in from the bundled canonical text.
      SkillsManager.getInstance().listSkills();
      return { ...readBuiltin(normalizedId), reset: true };
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) };
    }
  });
}
