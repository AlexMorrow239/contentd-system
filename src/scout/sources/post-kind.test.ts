import { describe, expect, it } from 'vitest'
import { classifyTarget } from './post-kind.js'

describe('classifyTarget', () => {
  const cases: [string, string | undefined, string][] = [
    ['reddit-hosted image', 'https://i.redd.it/u0g9ashc6mfh1.jpeg', 'image'],
    ['reddit-hosted gif', 'https://i.redd.it/k3zdrxuinpfh1.gif', 'image'],
    ['reddit-hosted video', 'https://v.redd.it/r5qx3m0zazbh1', 'image'],
    ['reddit preview host', 'https://preview.redd.it/abc.jpeg?width=640', 'image'],
    ['imgur album', 'https://imgur.com/a/WAs0im6', 'image'],
    ['imgur direct', 'https://i.imgur.com/abc123.png', 'image'],
    ['reddit gallery', 'https://www.reddit.com/gallery/1v7b8wq', 'image'],
    ['bare image extension', 'https://example.invalid/pretty.webp', 'image'],
    ['uppercase extension', 'https://example.invalid/PRETTY.JPG', 'image'],
    ['extension with query', 'https://example.invalid/a.png?v=2', 'image'],
    ['self post', 'https://www.reddit.com/r/space/comments/1v87hz5/what_will/', 'self'],
    ['astrobin page', 'https://app.astrobin.com/u/brent1123?i=fk1tqb', 'link'],
    ['youtube short link', 'https://youtu.be/EV2oqX6joRo', 'link'],
    ['news article', 'https://www.theguardian.com/science/2026/jul/27/jodrell', 'link'],
    ['undefined target', undefined, 'link'],
    ['unparseable target', 'not a url', 'link'],
  ]

  for (const [label, url, expected] of cases) {
    it(`classifies ${label} as ${expected}`, () => {
      expect(classifyTarget(url)).toBe(expected)
    })
  }

  it('does not treat a comments permalink on a media host lookalike as self', () => {
    expect(classifyTarget('https://notreddit.invalid/r/space/comments/x/')).toBe('link')
  })
})
