// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import type { SkillPackageReference } from '@paperclipai/shared';
import { SkillReferenceChoices } from './SkillPackagePreview';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('skill reference choices', () => {
  it('lets a user remove a saved dependency that has disappeared', async () => {
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host);
    let selection = ['runtime/SKILL.md'];
    function Example() {
      const [included, setIncluded] = useState(selection);
      selection = included;
      return <SkillReferenceChoices references={[{ fromPath: 'SKILL.md', target: '../runtime/SKILL.md', resolvedPath: 'runtime/SKILL.md', kind: 'outside_package' }]} included={included} onChange={setIncluded} />;
    }
    try {
      await act(async () => root.render(<Example />));
      expect(host.textContent).toContain('No longer available · uncheck to remove');
      await act(async () => host.querySelector<HTMLInputElement>('input')!.click());
      expect(selection).toEqual([]);
      expect(host.querySelector('input')).toBeNull();
    } finally { await act(async () => root.unmount()); host.remove(); }
  });
  it('selects and unselects complete skill/folder imports, with no checkbox for missing paths', async () => {
    const references: SkillPackageReference[] = [
      { fromPath: 'SKILL.md', target: '../runtime/SKILL.md', resolvedPath: 'skills/runtime/SKILL.md', kind: 'outside_package', import: { kind: 'skill', path: 'skills/runtime', fileCount: 5 } },
      { fromPath: 'references/guide.md', target: '../../scripts/run.py', resolvedPath: 'scripts/run.py', kind: 'outside_package', import: { kind: 'folder', path: 'scripts', fileCount: 2 } },
      { fromPath: 'SKILL.md', target: './absent.md', resolvedPath: 'skills/architect/absent.md', kind: 'missing' },
    ];
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host);
    let selection: string[] = [];
    function Example() {
      const [included, setIncluded] = useState<string[]>([]);
      selection = included;
      return <SkillReferenceChoices references={references} included={included} onChange={setIncluded} />;
    }
    try {
      await act(async () => root.render(<Example />));
      expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
      expect(host.textContent).toContain('Whole skill · skills/runtime · 5 files');
      expect(host.textContent).toContain('Whole folder · scripts · 2 files');
      expect(host.textContent).toContain('Not found');
      const skill = host.querySelector<HTMLInputElement>('[aria-label="Include ../runtime/SKILL.md"]')!;
      const script = host.querySelector<HTMLInputElement>('[aria-label="Include ../../scripts/run.py"]')!;
      await act(async () => skill.click());
      await act(async () => script.click());
      expect(selection).toEqual(['skills/runtime/SKILL.md', 'scripts/run.py']);
      expect(skill.checked).toBe(true);
      await act(async () => skill.click());
      expect(selection).toEqual(['scripts/run.py']);
    } finally { await act(async () => root.unmount()); host.remove(); }
  });
});
