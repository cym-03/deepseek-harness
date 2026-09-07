import { randomBytes } from 'node:crypto'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { prepareVisionImageForEmbedding } from '../src/kb/vision-embed.ts'

describe('vision embedding image preparation', () => {
  it('keeps an image that already fits the request limit unchanged', async () => {
    const image = Buffer.from('small-image')
    await expect(prepareVisionImageForEmbedding(image, 'image/png')).resolves.toEqual({
      data: image,
      mime: 'image/png',
    })
  })

  it('converts an oversized source image to a bounded JPEG request asset', async () => {
    const width = 2200
    const height = 2200
    const source = await sharp(randomBytes(width * height * 3), {
      raw: { width, height, channels: 3 },
    }).png({ compressionLevel: 0 }).toBuffer()
    expect(source.byteLength).toBeGreaterThan(7 * 1024 * 1024)

    const prepared = await prepareVisionImageForEmbedding(source, 'image/png')
    expect(prepared.mime).toBe('image/jpeg')
    expect(prepared.data.byteLength).toBeLessThanOrEqual(7 * 1024 * 1024)
    expect(prepared.data.byteLength).toBeLessThan(source.byteLength)
  })

  it('normalizes an exported SVG board to PNG', async () => {
    const source = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="blue"/></svg>')
    const prepared = await prepareVisionImageForEmbedding(source, 'image/svg+xml')

    expect(prepared.mime).toBe('image/png')
    expect(await sharp(prepared.data).metadata()).toMatchObject({ format: 'png', width: 20, height: 20 })
  })
})
