import { describe, expect, it } from 'vitest'
import { appBase, parseAppRoutes, resolveAppRoute, validateAppPath } from './appRoutes'

describe('host-owned app aliases', () => {
  it('defaults to no aliases and resolves opaque relative paths only within the selected app', () => {
    expect(parseAppRoutes(undefined).size).toBe(0)
    const routes = parseAppRoutes('{"models":"example","notes":"other"}')
    expect(appBase('example', routes)).toBe('/models')
    expect(appBase('missing', routes)).toBeUndefined()
    expect(resolveAppRoute('/models', routes)).toEqual({ vendor: 'example', base: '/models', path: '/' })
    expect(resolveAppRoute('/models/opaque-id', routes)?.path).toBe('/opaque-id')
    expect(resolveAppRoute('/models-other/id', routes)).toBeNull()
    expect(resolveAppRoute('/unknown', routes)).toBeNull()
    expect(resolveAppRoute('/models/%2e%2e/notes', routes)).toBeNull()
  })

  it.each(['api', 'blueprints', 'outputs', 'gatekeepers', 'gatekeeper', 'workspace',
    'workspaces', 'context', 'blueprint', 'blueprint-screenshot', 'connect', 'admin', 'assets',
    'providers', 'profile', 'explore', 'signup', 'gadget'])('reserves /%s', (slug) => {
    expect(() => parseAppRoutes(JSON.stringify({ [slug]: 'example' }))).toThrow('Invalid or conflicting')
  })

  it.each(['[]', 'null', '"models"', '{', '{"models":"example","notes":"example"}',
    '{"models/other":"example"}', '{"models":"https://example.com"}',
    '{"Models":"example"}', '{"models":"../example"}', '{"models":1}',
    '{"__proto__":"example"}', '{"models?x":"example"}', '{"models#x":"example"}'])(
  'rejects malformed or conflicting config %s', (json) => {
    expect(() => parseAppRoutes(json)).toThrow(/./)
  })

  it('bounds configuration and path lengths', () => {
    expect(() => parseAppRoutes(' '.repeat(16385))).toThrow('too large')
    expect(() => parseAppRoutes(JSON.stringify(Object.fromEntries(
      Array.from({ length: 65 }, (_, i) => [`app-${i}`, `vendor-${i}`]),
    )))).toThrow('Too many')
    expect(validateAppPath('/' + 'x'.repeat(2047))).toHaveLength(2048)
    expect(() => validateAppPath('/' + 'x'.repeat(2048))).toThrow('Invalid app-relative path')
  })

  it.each(['', '//evil.test', 'https://evil.test', 'javascript:alert(1)', '../notes', '/..',
    '/a/../b', '/a/./b', '/a//b', '/a/', '/%2fnotes', '/%5cnotes', '/%252fnotes',
    '/a?query', '/a#hash', '/a\\b', '/a\nb', '/a\u0000b', '/a:b'])(
  'rejects ambiguous app-relative path %s', (path) => {
    expect(() => validateAppPath(path)).toThrow('Invalid app-relative path')
  })
})
