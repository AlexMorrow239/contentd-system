'use client'
import { useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { filtersUrl, type FilterValues } from '../lib/shared/filters'

function remember(storageKey: string, filters: FilterValues) {
  try {
    if (Object.values(filters).some(Boolean))
      localStorage.setItem(storageKey, JSON.stringify(filters))
    else localStorage.removeItem(storageKey)
  } catch {
    /* URL filtering remains usable with storage disabled. */
  }
}

export function FilterBar({
  path,
  storageKey,
  keys,
  parse,
  searchLabel,
  placeholder,
  selects,
}: {
  path: string
  storageKey: string
  keys: readonly string[]
  parse: (raw: Record<string, unknown>) => FilterValues
  searchLabel: string
  placeholder: string
  selects: {
    key: string
    label: string
    all: string
    options: { value: string; label?: string }[]
  }[]
}) {
  const search = useSearchParams()
  const router = useRouter()
  const query = search.toString()
  const [draft, setDraft] = useState(() => parse(Object.fromEntries(search)))
  const latest = useRef(draft)
  const navigating = useRef<string | null>(null)
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    const params = new URLSearchParams(query)
    const filters = parse(Object.fromEntries(params))
    // Bare navigation restores preferences even when this component stays mounted.
    if (!keys.some((key) => params.has(key)) && !params.has('page')) {
      try {
        const raw: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '{}')
        const saved = parse(
          typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {},
        )
        if (keys.some((key) => saved[key])) {
          latest.current = saved
          setDraft(saved)
          const target = filtersUrl(path, keys, saved)
          navigating.current = target
          router.replace(target, { scroll: false })
          return
        }
      } catch {
        /* Invalid or inaccessible storage leaves URL filtering usable. */
      }
    }
    const current = `${path}${query ? `?${query}` : ''}`
    if (navigating.current) {
      if (navigating.current === current) navigating.current = null
      return
    }
    clearTimeout(debounce.current)
    latest.current = filters
    setDraft(filters)
    remember(storageKey, filters)
  }, [query, router, path, storageKey, keys, parse])

  useEffect(() => {
    function onPopState() {
      // Back/Forward is authoritative even if it interrupts one of our replacements.
      navigating.current = null
      clearTimeout(debounce.current)
      const filters = parse(Object.fromEntries(new URLSearchParams(window.location.search)))
      latest.current = filters
      setDraft(filters)
    }
    window.addEventListener('popstate', onPopState)
    return () => {
      clearTimeout(debounce.current)
      window.removeEventListener('popstate', onPopState)
    }
  }, [parse])

  function apply(next: FilterValues) {
    remember(storageKey, next)
    const target = filtersUrl(path, keys, next)
    const current = `${path}${query ? `?${query}` : ''}`
    if (target !== current || navigating.current !== null) {
      // Replacing with the current URL still cancels an older pending navigation.
      navigating.current = target === current ? null : target
      router.replace(target, { scroll: false })
    }
  }

  function change(key: string, value: string) {
    clearTimeout(debounce.current)
    const next = { ...latest.current, [key]: value || undefined }
    latest.current = next
    setDraft(next)
    if (key === 'q') debounce.current = setTimeout(() => apply(next), 300)
    else apply(next)
  }

  return (
    <form
      className="filters filter-bar"
      onSubmit={(event) => {
        event.preventDefault()
        clearTimeout(debounce.current)
        apply(latest.current)
      }}
    >
      <label className="filter-search">
        {searchLabel}
        <input
          type="search"
          value={draft.q ?? ''}
          placeholder={placeholder}
          onChange={(event) => change('q', event.target.value)}
        />
      </label>
      {selects.map(({ key, label, all, options }) => {
        const selected = draft[key]
        const available =
          selected && !options.some((option) => option.value === selected)
            ? [...options, { value: selected }]
            : options
        return (
          <label key={key}>
            {label}
            <select value={selected ?? ''} onChange={(event) => change(key, event.target.value)}>
              <option value="">{all}</option>
              {available.map(({ value, label }) => (
                <option key={value} value={value}>
                  {label ?? value}
                </option>
              ))}
            </select>
          </label>
        )
      })}
      <button
        type="button"
        className="secondary-button"
        onClick={() => {
          clearTimeout(debounce.current)
          latest.current = {}
          setDraft({})
          apply({})
        }}
      >
        Clear filters
      </button>
    </form>
  )
}
