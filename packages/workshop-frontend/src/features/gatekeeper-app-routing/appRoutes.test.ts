import { expect, it } from 'vitest'
import { appPathFromLocation, gatekeeperAppBase, validateAppPath } from './appRoutes'

it('accepts bounded canonical app-relative identifier paths', () => {
  for (const path of ['/', '/domain-models', '/domain-models/5d4f8b32-8b66-4c62-b331-11bf59658456', '/outputs', '/' + 'a'.repeat(2047)]) {
    expect(validateAppPath(path)).toBe(path)
  }
})

it('rejects ambiguous, external and noncanonical paths', () => {
  for (const path of ['', 'https://evil.test', '//evil.test', '/a//b', '/a/', '/..', '/a/../b', '/a?x', '/a#x', '/%2f', '/é', '/a\\b', '/' + 'a'.repeat(2048)]) {
    expect(() => validateAppPath(path)).toThrow('Invalid app-relative path')
  }
})

it('bounds decoded app identifiers to one namespace without rejecting encoded letters', () => {
  expect(gatekeeperAppBase('Example_1-app')).toBe('/gatekeepers/Example_1-app')
  for (const id of ['', '.', '..', 'example/other', 'example?query', 'example#hash', '%2f', 'https:', 'é']) {
    expect(() => gatekeeperAppBase(id)).toThrow('Invalid gatekeeper app identifier')
  }
  const base = gatekeeperAppBase('example')
  expect(appPathFromLocation('/gatekeepers/%65xample/domain-models', base)).toBe('/domain-models')
  expect(appPathFromLocation('/gatekeepers/example', base)).toBe('/')
  expect(appPathFromLocation('/gatekeepers/other/domain-models', base)).toBeNull()
  expect(appPathFromLocation('/gatekeepers/example-other/domain-models', base)).toBeNull()
  expect(appPathFromLocation('/gatekeepers/example/%2fescape', base)).toBeNull()
})
