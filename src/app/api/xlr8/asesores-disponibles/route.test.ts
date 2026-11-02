import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  consultar: vi.fn(),
}))

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: mocks.getCurrentAccount,
  toErrorResponse: vi.fn(() => Response.json({ error: 'Unauthorized' }, { status: 401 })),
}))

vi.mock('@/lib/asesores-disponibles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/asesores-disponibles')>()),
  consultarAsesoresDisponibles: mocks.consultar,
}))

import { GET } from './route'

function como(role: string) {
  mocks.getCurrentAccount.mockResolvedValue({ role, accountId: 'acc-1', userId: 'u-1' })
}

beforeEach(() => {
  mocks.getCurrentAccount.mockReset()
  mocks.consultar.mockReset()
  mocks.consultar.mockResolvedValue({ estado: 'ok', asesores: [{ id: 1, nombre: 'Alexia' }] })
})

describe('GET /api/xlr8/asesores-disponibles', () => {
  it.each(['owner', 'admin', 'atc'])('%s ve la lista', async (role) => {
    como(role)
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ estado: 'ok', asesores: [{ id: 1, nombre: 'Alexia' }] })
  })

  it.each(['gerencia', 'jefe_linea', 'agent', 'viewer', 'analista', 'community_manager'])(
    '%s recibe 403 y no se consulta el PHP',
    async (role) => {
      como(role)
      const res = await GET()
      expect(res.status).toBe(403)
      expect(mocks.consultar).not.toHaveBeenCalled()
    }
  )

  it('sin sesión responde el error de auth', async () => {
    mocks.getCurrentAccount.mockRejectedValue(new Error('no session'))
    const res = await GET()
    expect(res.status).toBe(401)
    expect(mocks.consultar).not.toHaveBeenCalled()
  })
})
