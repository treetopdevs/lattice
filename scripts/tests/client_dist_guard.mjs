import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

// Execute the actual workflow body against a tiny real TypeScript package and Git index.
const workflow = readFileSync(new URL('../../.github/workflows/flagship.yml', import.meta.url), 'utf8');
const body = workflow.match(/      - name: Committed TS client dist matches build\n[\s\S]*?        run: \|\n([\s\S]*?)(?=      - name:)/)?.[1];
assert.ok(body, 'client distribution workflow step must exist');
const guard = body.split('\n').map(line => line.replace(/^          /, '')).join('\n');
const compiler = resolve('clients/lattice-client/node_modules/typescript/bin/tsc');

for (const mutation of ['delete', 'rename']) {
  test(`clean distribution guard rejects ${mutation}d source outputs`, () => {
    const root = mkdtempSync(join(tmpdir(), 'lattice-dist-'));
    const client = join(root, 'clients/lattice-client');
    const run = (command, args) => spawnSync(command, args, { cwd: root, encoding: 'utf8' });
    const ok = (command, args) => {
      const result = run(command, args);
      assert.equal(result.status, 0, result.stdout + result.stderr);
    };
    try {
      mkdirSync(join(client, 'src'), { recursive: true });
      writeFileSync(join(client, 'package.json'), JSON.stringify({ scripts: { build: `node ${JSON.stringify(compiler)} -p tsconfig.json` } }));
      writeFileSync(join(client, 'tsconfig.json'), JSON.stringify({ compilerOptions: { declaration: true, outDir: 'dist', rootDir: '.', types: [] }, include: ['src'] }));
      writeFileSync(join(client, 'src/index.ts'), 'export const current = 1;\n');
      writeFileSync(join(client, 'src/old.ts'), 'export const old = 1;\n');
      ok('git', ['init', '-q']);
      ok('npm', ['--prefix', client, 'run', 'build']);
      ok('git', ['add', '.']);
      ok('git', ['-c', 'user.name=Regression', '-c', 'user.email=regression@example.invalid', 'commit', '-qm', 'fixture']);
      assert.equal(run('bash', ['-eu', '-c', guard]).status, 0, 'fresh tracked output must pass');
      if (mutation === 'delete') rmSync(join(client, 'src/old.ts'));
      else renameSync(join(client, 'src/old.ts'), join(client, 'src/new.ts'));
      // An in-place tsc build retains old.js and old.d.ts. For a rename, commit the
      // new outputs too, reproducing the false green from both original Git checks.
      ok('npm', ['--prefix', client, 'run', 'build']);
      ok('git', ['add', '.']);
      ok('git', ['-c', 'user.name=Regression', '-c', 'user.email=regression@example.invalid', 'commit', '-qm', mutation]);
      ok('git', ['diff', '--exit-code', '--', 'clients/lattice-client/dist']);
      assert.equal(run('git', ['status', '--porcelain', '--untracked-files=all', '--', 'clients/lattice-client/dist']).stdout, '');
      const rejected = run('bash', ['-eu', '-c', guard]);
      assert.notEqual(rejected.status, 0, rejected.stdout + rejected.stderr);
      assert.match(rejected.stdout, /old\.(js|d\.ts)/);
      ok('git', ['add', '.']);
      ok('git', ['-c', 'user.name=Regression', '-c', 'user.email=regression@example.invalid', 'commit', '-qm', 'clean outputs']);
      assert.equal(run('bash', ['-eu', '-c', guard]).status, 0, 'corrected clean output must pass');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
