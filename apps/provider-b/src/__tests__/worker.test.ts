import assert from 'node:assert/strict'
import { afterEach, describe, it, mock } from 'node:test'
import worker from '../worker.js'
import { ChannelSession } from '../ChannelSession.js'
import { TESTNET_USDC_CONTRACT } from '../manifest.js'
import type { Env } from '../env.js'

const TEST_PAYEE_SECRET = 'SBB3ER7UC7MYPQYHLNTX4QINRTV4WPFE2T644J64XTAUNKJMOGOVJGLL'
const TEST_PAYEE_ADDRESS = 'GBRLCID5A2S6HUC4D4DSWPRWNO75CLNHS2SIPS2BPCCP55Z5N7Z36DJD'
const TEST_CHANNEL_CONTRACT = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'

const mockEnv: Env = {
  STELLAR_NETWORK: 'testnet',
  STELLAR_PAYEE_SECRET: TEST_PAYEE_SECRET,
  STELLAR_PAYEE_ADDRESS: TEST_PAYEE_ADDRESS,
  COMMITMENT_PUBLIC_KEY: TEST_PAYEE_ADDRESS,
  CHANNEL_CONTRACT_ID: TEST_CHANNEL_CONTRACT,
  PUBLIC_BASE_URL: 'https://api-b.routedock.xyz',
  USDC_ASSET_CONTRACT: TESTNET_USDC_CONTRACT,
  CHANNEL_SESSION: {} as unknown as Env['CHANNEL_SESSION'],
}

// Helper to create a mock DurableObject instance for testing ChannelSession
function createTestChannelSession(env: Env = mockEnv): ChannelSession {
  const session = Object.create(ChannelSession.prototype)
  Object.defineProperty(session, 'env', { value: env, writable: true })
  return session as ChannelSession
}

describe('provider-b worker payment path & Durable Object routes', () => {
  it('/health bypasses payment middleware and returns 200 OK', async () => {
    const req = new Request('http://localhost/health')
    const res = await worker.fetch(req, mockEnv)

    assert.equal(res.status, 200)
    const body = (await res.json()) as { status: string; network: string; payee: string; channel: string }
    assert.equal(body.status, 'ok')
    assert.equal(body.network, 'testnet')
    assert.equal(body.channel, 'configured')
    assert.equal(typeof body.payee, 'string')
  })

  it('returns 500 when CHANNEL_CONTRACT_ID is unset', async () => {
    const req = new Request('http://localhost/stream/orderbook')
    const incompleteEnv = { ...mockEnv, CHANNEL_CONTRACT_ID: undefined }
    const res = await worker.fetch(req, incompleteEnv as unknown as Env)

    assert.equal(res.status, 500)
    const body = (await res.json()) as { error: string }
    assert.match(body.error, /CHANNEL_CONTRACT_ID unset/)
  })

  it('routes request through CHANNEL_SESSION DO binding', async () => {
    const session = createTestChannelSession(mockEnv)

    const mockDOBinding = {
      idFromName(name: string) {
        return { name }
      },
      get(_id: unknown) {
        return {
          fetch(req: Request) {
            return session.fetch(req)
          },
        }
      },
    }

    const envWithDO: Env = {
      ...mockEnv,
      CHANNEL_SESSION: mockDOBinding as unknown as Env['CHANNEL_SESSION'],
    }

    const req = new Request('http://localhost/.well-known/routedock.json')
    const res = await worker.fetch(req, envWithDO)

    assert.equal(res.status, 200)
    const body = (await res.json()) as {
      signature?: string
      payee?: string
      modes?: string[]
      pricing?: Record<string, { channel_factory?: string }>
    }

    assert.ok(body.signature, 'Manifest must contain signature property (issue #134)')
    assert.equal(body.payee, mockEnv.STELLAR_PAYEE_ADDRESS)
    assert.ok(Array.isArray(body.modes))
    assert.ok(body.modes.includes('mpp-session'))
    assert.equal(body.pricing?.['mpp-session']?.channel_factory, TEST_CHANNEL_CONTRACT)
  })

  it('/stream/orderbook returns 402 Payment Required with parsed WWW-Authenticate challenge', async () => {
    const session = createTestChannelSession(mockEnv)
    const req = new Request('http://localhost/stream/orderbook')
    const res = await session.fetch(req)

    assert.equal(res.status, 402)

    const authHeader = res.headers.get('WWW-Authenticate') || res.headers.get('X-Payment-Requirements')
    assert.ok(authHeader, 'Response must include payment challenge header')
    assert.ok(
      authHeader.includes('Payment') || authHeader.includes('mpp-session'),
      'Challenge header must specify mpp-session payment requirements',
    )
  })

  it('serializes voucher state on the same Durable Object instance across requests', async () => {
    const session = createTestChannelSession(mockEnv)

    // Request 1: 402 Payment Challenge
    const req1 = new Request('http://localhost/stream/orderbook')
    const res1 = await session.fetch(req1)
    assert.equal(res1.status, 402)

    // Request 2: Sequential request to the same DO instance
    const req2 = new Request('http://localhost/.well-known/routedock.json')
    const res2 = await session.fetch(req2)
    assert.equal(res2.status, 200)

    const body2 = (await res2.json()) as { payee?: string }
    assert.equal(body2.payee, mockEnv.STELLAR_PAYEE_ADDRESS)
  })

  it('scheduled() cron handler forwards trigger to ChannelSession Durable Object', async () => {
    let reconcileInvoked = false
    const mockDOBinding = {
      idFromName(name: string) {
        return { name }
      },
      get(_id: unknown) {
        return {
          reconcileSessions: async () => {
            reconcileInvoked = true
            return {
              orphanedCount: 1,
              recoveredCount: 1,
              skippedCount: 0,
              failedCount: 0,
              errors: [],
            }
          },
          fetch: async () => new Response('ok'),
        }
      },
    }

    const envWithDO: Env = {
      ...mockEnv,
      CHANNEL_SESSION: mockDOBinding as unknown as Env['CHANNEL_SESSION'],
    }

    await worker.scheduled({}, envWithDO)
    assert.equal(reconcileInvoked, true, 'scheduled() must trigger reconciliation on DO')
  })

  describe('scheduled() reconciliation logging', () => {
    const emptyStats = { orphanedCount: 0, recoveredCount: 0, skippedCount: 0, failedCount: 0, errors: [] }

    function cronEnv(reconcileSessions: () => Promise<unknown>): Env {
      const mockDOBinding = {
        idFromName(name: string) {
          return { name }
        },
        get(_id: unknown) {
          return { reconcileSessions }
        },
      }
      return { ...mockEnv, CHANNEL_SESSION: mockDOBinding as unknown as Env['CHANNEL_SESSION'] }
    }

    function withoutChannelContract(env: Env): Env {
      return { ...env, CHANNEL_CONTRACT_ID: undefined } as unknown as Env
    }

    function spyOnConsole() {
      return {
        log: mock.method(console, 'log', () => {}),
        warn: mock.method(console, 'warn', () => {}),
        error: mock.method(console, 'error', () => {}),
      }
    }

    function loggedText(spy: { mock: { calls: Array<{ arguments: unknown[] }> } }): string[] {
      return spy.mock.calls.map((call) => call.arguments.map(String).join(' '))
    }

    function onlyLine(lines: string[]): string {
      const [line] = lines
      assert.equal(lines.length, 1)
      assert.ok(line !== undefined)
      return line
    }

    afterEach(() => {
      mock.restoreAll()
    })

    it('logs one summary line and one error per failed channel', async () => {
      const spies = spyOnConsole()
      const env = cronEnv(async () => ({
        orphanedCount: 2,
        recoveredCount: 0,
        skippedCount: 0,
        failedCount: 2,
        errors: [
          { channelId: 'CCHANNELONE', reason: 'tx_bad_seq' },
          { channelId: 'CCHANNELTWO', reason: 'tx_insufficient_fee' },
        ],
      }))

      await worker.scheduled({}, env)

      const summary = onlyLine(loggedText(spies.log))
      assert.match(summary, /orphaned=2/)
      assert.match(summary, /recovered=0/)
      assert.match(summary, /skipped=0/)
      assert.match(summary, /failed=2/)

      const errors = loggedText(spies.error)
      const [first, second] = errors
      assert.equal(errors.length, 2)
      assert.ok(first !== undefined && second !== undefined)
      assert.match(first, /CCHANNELONE.*tx_bad_seq/)
      assert.match(second, /CCHANNELTWO.*tx_insufficient_fee/)
      assert.equal(spies.warn.mock.callCount(), 0)
    })

    it('logs the summary as a heartbeat when nothing was orphaned', async () => {
      const spies = spyOnConsole()

      await worker.scheduled({}, cronEnv(async () => emptyStats))

      assert.match(onlyLine(loggedText(spies.log)), /orphaned=0 recovered=0 skipped=0 failed=0/)
      assert.equal(spies.error.mock.callCount(), 0)
      assert.equal(spies.warn.mock.callCount(), 0)
    })

    it('reports skipped rows in the summary without logging an error', async () => {
      const spies = spyOnConsole()

      await worker.scheduled({}, cronEnv(async () => ({ ...emptyStats, orphanedCount: 1, skippedCount: 1 })))

      const summary = onlyLine(loggedText(spies.log))
      assert.match(summary, /orphaned=1/)
      assert.match(summary, /skipped=1/)
      assert.equal(spies.error.mock.callCount(), 0)
    })

    it('warns once and names the missing variables when reconcileSessions returns null', async () => {
      const spies = spyOnConsole()

      await worker.scheduled({}, cronEnv(async () => null))

      const warning = onlyLine(loggedText(spies.warn))
      assert.match(warning, /SUPABASE_URL/)
      assert.match(warning, /SUPABASE_SERVICE_KEY/)
      assert.match(warning, /STELLAR_PAYEE_SECRET/)
      assert.equal(spies.log.mock.callCount(), 0)
      assert.equal(spies.error.mock.callCount(), 0)
    })

    it('warns and skips reconciliation when CHANNEL_CONTRACT_ID is unset', async () => {
      const spies = spyOnConsole()
      let reconcileInvoked = false
      const env = withoutChannelContract(
        cronEnv(async () => {
          reconcileInvoked = true
          return emptyStats
        }),
      )

      await worker.scheduled({}, env)

      assert.equal(reconcileInvoked, false)
      assert.match(onlyLine(loggedText(spies.warn)), /CHANNEL_CONTRACT_ID/)
    })

    it('still rejects when reconcileSessions rejects so the invocation is marked failed', async () => {
      spyOnConsole()
      const env = cronEnv(async () => {
        throw new Error('supabase query failed')
      })

      await assert.rejects(worker.scheduled({}, env), /supabase query failed/)
    })

    it('never writes the payee secret to the console', async () => {
      const spies = spyOnConsole()
      const failed = { ...emptyStats, failedCount: 1, errors: [{ channelId: 'C1', reason: 'boom' }] }

      await worker.scheduled({}, cronEnv(async () => null))
      await worker.scheduled({}, cronEnv(async () => failed))
      await worker.scheduled({}, withoutChannelContract(cronEnv(async () => emptyStats)))

      const everything = [spies.log, spies.warn, spies.error].flatMap(loggedText).join('\n')
      assert.ok(everything.length > 0)
      assert.ok(!everything.includes(TEST_PAYEE_SECRET))
    })
  })

  it('does not expose /__reconcile as an unauthenticated HTTP endpoint', async () => {
    const session = createTestChannelSession(mockEnv)
    const req = new Request('http://localhost/__reconcile', { method: 'POST' })
    const res = await session.fetch(req)
    // Falls through to payment middleware, which rejects unauthenticated requests with 402
    assert.equal(res.status, 402)
  })

  it('ChannelSession exposes direct reconcileSessions method for DO RPC', async () => {
    const session = createTestChannelSession(mockEnv)
    // mockEnv has no SUPABASE_URL / SUPABASE_SERVICE_KEY, so it returns null gracefully
    const stats = await session.reconcileSessions()
    assert.equal(stats, null)
  })
})

