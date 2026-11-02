// Translate browser-owned constraint messages without changing constraints, values,
// submitting forms or moving focus. Unknown custom validators remain untouched.
export function installNativeValidation(i18n, document) {
  function update(field) {
    if (!field?.willValidate || typeof field.setCustomValidity !== 'function') return
    if (field.dataset.i18nInvalid) field.setCustomValidity('')
    const validity = field.validity
    let key, values
    if (validity.valueMissing) key = 'required'
    else if (validity.typeMismatch) key = 'type'
    else if (validity.patternMismatch) key = 'pattern'
    else if (validity.tooShort) { key = 'minLength'; values = { count: field.minLength } }
    else if (validity.tooLong) { key = 'maxLength'; values = { count: field.maxLength } }
    else if (validity.rangeUnderflow) { key = 'minValue'; values = { min: field.min } }
    else if (validity.rangeOverflow) { key = 'maxValue'; values = { max: field.max } }
    else if (validity.badInput || validity.stepMismatch) key = 'number'
    if (key) {
      field.setCustomValidity(i18n.t('validation.' + key, values))
      field.dataset.i18nInvalid = 'true'
    } else delete field.dataset.i18nInvalid
  }
  const invalid = event => update(event.target)
  const input = event => {
    const field = event.target
    if (field?.dataset?.i18nInvalid) { field.setCustomValidity(''); delete field.dataset.i18nInvalid }
  }
  const languageChanged = () => document.querySelectorAll('[data-i18n-invalid]').forEach(update)
  const reset = event => event.target.querySelectorAll?.('[data-i18n-invalid]').forEach(field => {
    field.setCustomValidity(''); delete field.dataset.i18nInvalid
  })
  // React can change a controlled value (Discard, reload, preset) without emitting
  // an input event. Never let a translated custom message keep a valid field invalid.
  const observer = document.defaultView?.MutationObserver ? new document.defaultView.MutationObserver(records => {
    for (const { target } of records) if (target.dataset?.i18nInvalid) update(target)
  }) : null
  observer?.observe(document.documentElement, { subtree: true, attributes: true,
    attributeFilter: ['value', 'min', 'max', 'minlength', 'maxlength', 'required', 'pattern', 'type', 'disabled'] })
  document.addEventListener('reset', reset, true)
  document.addEventListener('invalid', invalid, true)
  document.addEventListener('input', input, true)
  i18n.on('languageChanged', languageChanged)
  return () => {
    observer?.disconnect()
    document.removeEventListener('reset', reset, true)
    document.removeEventListener('invalid', invalid, true)
    document.removeEventListener('input', input, true)
    i18n.off('languageChanged', languageChanged)
  }
}
