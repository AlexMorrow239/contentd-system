import { html, SafeHtml } from '../html.js'

/**
 * The filter toolbar every listing page draws. Three pages spelled out the same
 * `<option selected>` branch and the same `<form class="filters">` wrapper; a
 * dropdown that silently lost its `selected` state on one page only is the
 * drift this exists to prevent.
 */

/** One `<option>`, marked selected when it is the current filter value. */
export function option(value: string, selected: string | undefined): SafeHtml {
  return selected === value
    ? html`<option value="${value}" selected>${value}</option>`
    : html`<option value="${value}">${value}</option>`
}

export interface FilterSelect {
  name: string
  /** The empty-value first option, e.g. 'all channels'. */
  allLabel: string
  values: readonly string[]
  selected: string | undefined
}

/**
 * A GET form back to the page itself. Selects render in the order given, since
 * each page orders its own dropdowns.
 */
export function filterForm(action: string, selects: FilterSelect[]): SafeHtml {
  const fields = selects.map(
    (select) => html`<select name="${select.name}">
      <option value="">${select.allLabel}</option>
      ${select.values.map((value) => option(value, select.selected))}
    </select>`,
  )
  return html`<form class="filters" method="get" action="${action}">
    ${fields}
    <button type="submit">filter</button>
  </form>`
}
