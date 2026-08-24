// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { apply, inject } from '../src/client/index.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
})

describe('browser-brand plugin (no occupants)', () => {
  it('declares no services', () => {
    expect(inject).toEqual([])
  })

  it('applies as a no-op without registering occupants', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await fiber.dispose()
  })
})
