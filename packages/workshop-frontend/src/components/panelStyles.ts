/**
 * Shared styling for the containers an admin tab is built out of, so every tab section -- and
 * every form inside one -- is bounded, spaced and labelled the same way.
 *
 * The vocabulary is three nested levels:
 *
 *   PANEL_CARD        one tab section, elevated against the page
 *     PANEL_GROUP_HEADING   a named group of controls inside it
 *       PANEL_BOX / PANEL_ROW   one bounded block: a setting, a list row, a form
 *
 * A form is a block like any other, so it sits in a PANEL_BOX rather than floating in the card's
 * flow, and its buttons sit under PANEL_FOOTER's rule the way a card's buttons do.
 */

/** One tab section. Elevated, so the sections read as cards against the page. */
export const PANEL_CARD = 'rounded-xl border border-kumo-line bg-kumo-elevated p-6'

/** A section's heading, directly inside PANEL_CARD. */
export const PANEL_TITLE = 'mb-1 text-lg font-semibold text-kumo-strong'

/** The sentence under PANEL_TITLE saying what the section is for. */
export const PANEL_LEDE = 'mb-5 text-sm text-kumo-subtle'

/** A named group of controls within a section. */
export const PANEL_GROUP_HEADING = 'mb-2 text-sm font-semibold text-kumo-default'

/**
 * One bounded block inside a section: a setting, a legend, a form. Recessed to `bg-kumo-base`, so
 * it reads as sitting *in* the card rather than as another card.
 */
export const PANEL_BOX = 'rounded-lg border border-kumo-line bg-kumo-base px-4 py-3'

/** A PANEL_BOX that is one row of a list, which is tighter because there are many of them. */
export const PANEL_ROW = 'rounded-lg border border-kumo-line bg-kumo-base px-3 py-2.5'

/** A label naming a group of fields inside a PANEL_BOX. */
export const PANEL_FIELD_LABEL = 'text-[13px] font-medium text-kumo-default'

/** The line under PANEL_FIELD_LABEL, or any aside at that level. */
export const PANEL_FIELD_DETAIL = 'text-[12px] leading-4 text-kumo-subtle'

/**
 * The buttons that act on a block, under a rule that separates them from what they act on. The
 * rule spans the block, so the footer is a child of the block and not of its padding.
 */
export const PANEL_FOOTER =
  'flex flex-wrap items-center gap-2 border-t border-kumo-line pt-3'
