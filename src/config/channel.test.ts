import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadChannelConfig } from './channel.js'

describe('loadChannelConfig', () => {
  it('parses channels/example.toml into a ChannelConfig', () => {
    const cfg = loadChannelConfig('channels/example.toml')
    expect(cfg.name).toBe('example')
    expect(cfg.niche).toEqual(['space facts', 'astronomy'])
    expect(cfg.scriptModel).toBe('claude-sonnet-5')
    expect(cfg.tierMix).toEqual({ volume: 2, premium: 1 })
    expect(cfg.voice).toEqual({ volume: 'af_heart' })
    expect(cfg.captionStyle).toEqual({
      font: 'Inter',
      fontSizePx: 72,
      activeColor: '#FFD700',
      inactiveColor: '#FFFFFF',
      strokePx: 8,
    })
    expect(cfg.bgDir).toBe('assets/bg')
    expect(cfg.bgmDir).toBe('assets/bgm')
    expect(cfg.budget).toEqual({
      perVideoUsdMicros: 8_000_000,
      perDayUsdMicros: 20_000_000,
    })
  })

  it('defaults scriptModel to claude-sonnet-5 when script_model is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chan-'))
    const file = join(dir, 'no-model.toml')
    writeFileSync(
      file,
      [
        'name = "nomodel"',
        'niche = ["x"]',
        'bg_dir = "assets/bg"',
        'bgm_dir = "assets/bgm"',
        '',
        '[tier_mix]',
        'volume = 1',
        'premium = 0',
        '',
        '[voice]',
        'volume = "af_heart"',
        '',
        '[caption_style]',
        'font = "Inter"',
        'font_size_px = 72',
        'active_color = "#FFD700"',
        'inactive_color = "#FFFFFF"',
        'stroke_px = 8',
        '',
        '[budget]',
        'per_video_usd = 8.0',
        'per_day_usd = 20.0',
        '',
      ].join('\n'),
    )
    const cfg = loadChannelConfig(file)
    expect(cfg.scriptModel).toBe('claude-sonnet-5')
  })

  it('throws when a required field is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chan-'))
    const file = join(dir, 'bad.toml')
    // [budget] table omitted entirely
    writeFileSync(
      file,
      [
        'name = "bad"',
        'niche = ["x"]',
        'bg_dir = "assets/bg"',
        'bgm_dir = "assets/bgm"',
        '',
        '[tier_mix]',
        'volume = 1',
        'premium = 0',
        '',
        '[voice]',
        'volume = "af_heart"',
        '',
        '[caption_style]',
        'font = "Inter"',
        'font_size_px = 72',
        'active_color = "#FFD700"',
        'inactive_color = "#FFFFFF"',
        'stroke_px = 8',
        '',
      ].join('\n'),
    )
    expect(() => loadChannelConfig(file)).toThrow()
  })

  it('throws when the file does not exist', () => {
    expect(() => loadChannelConfig('channels/does-not-exist.toml')).toThrow()
  })
})
