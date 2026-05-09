import { chromium } from 'playwright'
import Anthropic from '@anthropic-ai/sdk'
import fs from 'fs'
import path from 'path'
import os from 'os'

let _anthropic: Anthropic | null = null
function getAnthropic() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
  return _anthropic
}

export interface SlideshowResult {
  transcript: string
  thumbnailUrl: string | null
  title: string | null
}

export async function extractSlideshow(url: string): Promise<SlideshowResult> {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || undefined,
  })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  })

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinned-slides-'))
  const imageBuffers: Buffer[] = []

  try {
    const page = await context.newPage()

    // Intercept image responses to capture slideshow images
    const capturedImageUrls: Set<string> = new Set()
    page.on('response', async (response) => {
      const reqUrl = response.url()
      const ct = response.headers()['content-type'] ?? ''
      if (ct.startsWith('image/') && reqUrl.includes('tiktok') && !reqUrl.includes('avatar') && !reqUrl.includes('icon')) {
        try {
          const buf = await response.body()
          if (buf.length > 20_000) { // skip tiny icons
            capturedImageUrls.add(reqUrl)
          }
        } catch {}
      }
    })

    await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 })
    await page.waitForTimeout(2000)

    const title = await page.$eval('meta[property="og:title"]', el => el.getAttribute('content')).catch(() => null)
    const thumbnailUrl = await page.$eval('meta[property="og:image"]', el => el.getAttribute('content')).catch(() => null)

    // Try to find and click through slideshow arrows to trigger more image loads
    for (let i = 0; i < 12; i++) {
      const clicked = await page.evaluate(() => {
        // TikTok uses various button patterns
        const selectors = [
          '[data-e2e="arrow-right"]',
          'button[aria-label*="next" i]',
          'button[aria-label*="Next" i]',
          '.swiper-button-next',
          '[class*="arrow"][class*="right"]',
          '[class*="next"]',
        ]
        for (const sel of selectors) {
          const el = document.querySelector(sel) as HTMLElement | null
          if (el) { el.click(); return true }
        }
        // Fallback: send ArrowRight to body
        document.body.dispatchEvent(new (window as any).KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, keyCode: 39 }))
        return false
      })
      await page.waitForTimeout(500)
    }

    // Also try swiping on the image container
    const imgContainer = await page.$('[class*="swiper"], [class*="slide"], [class*="carousel"]')
    if (imgContainer) {
      const box = await imgContainer.boundingBox()
      if (box) {
        for (let i = 0; i < 8; i++) {
          await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2)
          await page.mouse.down()
          await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2, { steps: 10 })
          await page.mouse.up()
          await page.waitForTimeout(400)
        }
      }
    }

    // Download all unique captured images
    for (const imgUrl of capturedImageUrls) {
      try {
        const res = await fetch(imgUrl)
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer())
          imageBuffers.push(buf)
        }
      } catch {}
    }

    // If network interception got nothing, fall back to DOM src extraction
    if (imageBuffers.length === 0) {
      const srcs = await page.$$eval('img', imgs =>
        imgs.map(i => i.src).filter(s => s.includes('tiktok') && !s.includes('avatar'))
      )
      for (const src of [...new Set(srcs)].slice(0, 10)) {
        try {
          const res = await fetch(src)
          if (res.ok) {
            const buf = Buffer.from(await res.arrayBuffer())
            if (buf.length > 20_000) imageBuffers.push(buf)
          }
        } catch {}
      }
    }

    await browser.close()

    if (imageBuffers.length === 0) {
      throw new Error('Could not capture any slideshow images')
    }

    console.log(`   Captured ${imageBuffers.length} slide image(s), sending to Claude Vision...`)

    // Send all images to Claude Vision in one call
    const imageBlocks = imageBuffers.slice(0, 8).map(buf => ({
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: 'image/jpeg' as const,
        data: buf.toString('base64'),
      },
    }))

    const message = await getAnthropic().messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: [
          ...imageBlocks,
          {
            type: 'text',
            text: `These are slides from a TikTok. Transcribe EVERY word of visible text from each slide exactly as it appears — including performer names, event names, venue names, dates, times, addresses, ticket info, presale info, and all text overlays. Do not interpret or summarize — just read the text.

Format as plain sentences: "Slide 1: [all text verbatim]. Slide 2: [all text verbatim]." etc.

Important notes:
- Dates like "July_24" mean July 24
- "b2b" is a DJ format meaning back-to-back (two performers)
- Include ALL text even if it seems like a caption, hashtag, or ticket detail
- If a slide is a flyer or event poster, read every line including the small print`,
          },
        ],
      }],
    })

    const transcript = message.content[0].type === 'text' ? message.content[0].text : ''
    console.log(`   Claude Vision transcript (${transcript.length} chars): ${transcript.slice(0, 200)}`)
    return { transcript, thumbnailUrl, title }

  } finally {
    await browser.close().catch(() => {})
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}
