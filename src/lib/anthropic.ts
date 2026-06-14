import Anthropic from '@anthropic-ai/sdk'
import { loadEnv } from '../config/env.js'

// ─────────────────────────────────────────────────────────────────────────────
// Cliente Anthropic. La IA vive ACA, en el servicio (en F4 sale del env de la PWA).
// El servicio es una caja negra: la PWA manda un comando y nunca ve este modulo.
// ─────────────────────────────────────────────────────────────────────────────

let cached: Anthropic | null = null

function getClient(): Anthropic {
  if (cached) return cached
  const env = loadEnv()
  cached = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
  return cached
}

export interface RespuestaModelo {
  texto: string
  tokensIn: number
  tokensOut: number
}

/**
 * Puerto de inferencia: dado un model_id y un prompt, devuelve texto + uso de
 * tokens. Aislado tras esta firma para que los servicios se testeen con un doble.
 */
export type Inferencia = (args: {
  modelId: string
  system: string
  user: string
  maxTokens: number
}) => Promise<RespuestaModelo>

export const inferirConAnthropic: Inferencia = async ({
  modelId,
  system,
  user,
  maxTokens,
}) => {
  const client = getClient()
  const res = await client.messages.create({
    model: modelId,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  })
  const texto = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
  return {
    texto,
    tokensIn: res.usage.input_tokens,
    tokensOut: res.usage.output_tokens,
  }
}
