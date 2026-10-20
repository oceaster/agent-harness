import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { repositoryCommitHash, writeClientBuildRecord } from './client-build-environment.ts'
import { verifyDeploymentBuild } from './verify-deployment-build.ts'

const roots: string[] = []

function write(root: string, name: string, content: string): void {
  const path = join(root, name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function git(root: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Build Test', '-c', 'user.email=build-test@example.invalid', ...args], {
    cwd: root, stdio: 'pipe',
  })
}

function record(root: string): void {
  writeClientBuildRecord(root, { DSH_CLIENT_COMMIT_HASH: repositoryCommitHash(root, {}) })
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'deployment-build-'))
  roots.push(root)
  write(root, '.gitignore', 'lib/\ndist/\n.dsh-build/\n')
  write(root, 'packages/client/alive/package.json', '{"name":"alive"}')
  write(root, 'packages/client/alive/src/index.ts', 'export {}')
  git(root, 'init')
  git(root, 'add', '.')
  git(root, 'commit', '-m', 'source')
  write(root, 'apps/web/dist/index.html', '<main>built</main>')
  write(root, 'packages/client/alive/lib/client.js', 'built()')
  record(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('accepts a complete build of the checked-out source', () => {
  expect(() => { verifyDeploymentBuild(fixture()) }).not.toThrow()
})

it('rejects unchanged artifacts after pulling a new source commit', () => {
  const root = fixture()
  write(root, 'packages/client/alive/src/index.ts', 'export const changed = true')
  git(root, 'add', '.')
  git(root, 'commit', '-m', 'new source')
  expect(() => { verifyDeploymentBuild(root) }).toThrow(/not built from HEAD/)
})

it('rejects uncommitted source changes even when the recorded commit matches', () => {
  const root = fixture()
  write(root, 'packages/client/alive/src/index.ts', 'export const changed = true')
  expect(() => { verifyDeploymentBuild(root) }).toThrow(/tracked source changes/)
})

it('rejects a mixed set of artifacts after a partial rebuild', () => {
  const root = fixture()
  write(root, 'packages/client/alive/lib/client.js', 'partiallyRebuilt()')
  expect(() => { verifyDeploymentBuild(root) }).toThrow(/artifacts differ/)
})

it('rejects a deleted plugin artifact even when a build recorded it', () => {
  const root = fixture()
  write(root, 'packages/client/deleted-inventory/lib/client.js', 'injectRemotePluginInventory()')
  record(root)
  expect(() => { verifyDeploymentBuild(root) }).toThrow(/deleted package.*deleted-inventory/)
})

it('rejects missing build records and missing browser shells', () => {
  const root = fixture()
  rmSync(join(root, 'apps/web/dist/index.html'))
  record(root)
  expect(() => { verifyDeploymentBuild(root) }).toThrow(/index.html is missing/)
  rmSync(join(root, '.dsh-build'), { recursive: true })
  expect(() => { verifyDeploymentBuild(root) }).toThrow(/record.*missing/)
})
