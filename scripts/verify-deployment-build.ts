import { execFileSync } from 'node:child_process'
import { existsSync, globSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { readClientBuildRecord, repositoryCommitHash } from './client-build-environment.ts'

/** Reject a deployment whose browser artifacts do not belong to its checked-out source. */
export function verifyDeploymentBuild(root: string): void {
  const record = readClientBuildRecord(root)
  const commit = repositoryCommitHash(root, {})
  if (record.environment.DSH_CLIENT_COMMIT_HASH !== commit) {
    throw new Error(`deployment build: artifacts are not built from HEAD ${commit}; run pnpm run clean && pnpm install --frozen-lockfile && pnpm run build`)
  }
  const changes = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  if (changes !== '') {
    throw new Error('deployment build: tracked source changes are not represented by the built commit; commit and rebuild before deploying')
  }
  if (!existsSync(resolve(root, 'apps/web/dist/index.html'))) {
    throw new Error('deployment build: apps/web/dist/index.html is missing; run pnpm run build')
  }
  for (const artifact of globSync('packages/*/*/lib/client.js', { cwd: root })) {
    const packageDirectory = dirname(dirname(resolve(root, artifact)))
    if (!existsSync(resolve(packageDirectory, 'package.json'))) {
      throw new Error(`deployment build: deleted package still has a browser artifact: ${artifact}; run pnpm run clean && pnpm install --frozen-lockfile && pnpm run build`)
    }
  }
}

if (import.meta.main) {
  try {
    verifyDeploymentBuild(resolve(import.meta.dirname, '..'))
    console.log('deployment build: current source and browser artifacts agree')
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
