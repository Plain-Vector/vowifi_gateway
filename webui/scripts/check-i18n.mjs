import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/i18n/locales')
export function flatten(object, prefix = '') { return Object.fromEntries(Object.entries(object).flatMap(([key, value]) => typeof value === 'string' ? [[prefix + key, value]] : Object.entries(flatten(value, prefix + key + '.')))) }
export function placeholders(text) { return [...text.matchAll(/{{\s*([^},]+)(?:,[^}]+)?}}/g)].map(m => m[1].trim()).sort() }
export function validateCatalogs(catalogs) {
  const english = flatten(catalogs.en); const errors = []
  for (const language of ['en', 'fr', 'ru']) {
    const values = flatten(catalogs[language]);
    for (const key of new Set([...Object.keys(english), ...Object.keys(values)])) {
      if (!(key in values) || !(key in english)) { errors.push(`${language}: missing or extra key ${key}`); continue }
      if (!values[key].trim()) errors.push(`${language}: empty ${key}`)
      if (JSON.stringify(placeholders(values[key])) !== JSON.stringify(placeholders(english[key]))) errors.push(`${language}: placeholders ${key}`)
      const tags = text => [...text.matchAll(/<\/?(\d+)\s*\/?\s*>/g)].map(m => m[1]).sort()
      if (JSON.stringify(tags(values[key])) !== JSON.stringify(tags(english[key]))) errors.push(`${language}: markup ${key}`)
    }
  }
  return errors
}
const catalogs = Object.fromEntries(['en','fr','ru'].map(language => [language, JSON.parse(fs.readFileSync(path.join(directory, language + '.json'), 'utf8'))]))
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const errors = validateCatalogs(catalogs)
  const keys = flatten(catalogs.en)
  const roots = Object.keys(catalogs.en).join('|')
  const pattern = new RegExp(`['"\`]((?:${roots})\\.[a-zA-Z0-9_.]+)['"\`]`, 'g')
  function inspect(folder) {
    for (const entry of fs.readdirSync(folder, {withFileTypes:true})) {
      if (entry.name === '__tests__' || entry.name === 'locales') continue
      const filename = path.join(folder, entry.name)
      if (entry.isDirectory()) inspect(filename)
      else if (/\.jsx?$/.test(entry.name)) {
        const source = fs.readFileSync(filename, 'utf8')
        for (const match of source.matchAll(pattern)) if (!match[1].endsWith('.') && !(match[1] in keys) && !((match[1] + '_other') in keys)) errors.push(`${filename}: unregistered key ${match[1]}`)
      }
    }
  }
  inspect(path.resolve(directory, '../..'))
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1 }
  else console.log(`i18n: ${Object.keys(flatten(catalogs.en)).length} complete keys in en/fr/ru; placeholders and markup match`)
}
