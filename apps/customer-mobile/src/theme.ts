import { StyleSheet } from 'react-native'

import { colors, ink, line, surface } from '@alo-noon/design-tokens'

/**
 * The pieces of the app's visual language that more than one screen needs.
 *
 * Pulled out of App.tsx when the second and third screens arrived. Before that
 * there was one screen and keeping its styles next to it was right; now three
 * files would each be inventing their own card radius, and a card that is 28
 * here and 24 there is the kind of difference nobody can name but everybody
 * sees.
 *
 * Deliberately small. Anything used by exactly one screen still belongs to that
 * screen — a shared stylesheet that collects everything becomes a second place
 * to look for every answer.
 */
export const sharedStyles = StyleSheet.create({
  card: {
    gap: 16,
    padding: 24,
    borderWidth: 1,
    borderColor: line.subtle,
    borderRadius: 28,
    backgroundColor: surface.card,
  },
  title: {
    color: colors.neutral[900],
    fontSize: 28,
    fontWeight: '800',
    textAlign: 'right',
  },
  subtitle: {
    color: ink.muted,
    fontSize: 15,
    lineHeight: 26,
    textAlign: 'right',
  },
  /** A row that reads right-to-left with its ends pushed apart. */
  rowBetween: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  label: {
    color: ink.muted,
    fontSize: 13,
    textAlign: 'right',
  },
  value: {
    color: ink.strong,
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'right',
  },
  /**
   * A row inside a card, separated by a hairline rather than a gap.
   *
   * Orders and addresses are lists of like things, and a border between them
   * reads as one list; spacing alone reads as several cards that happen to be
   * near each other.
   */
  listRow: {
    gap: 8,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: line.subtle,
  },
  listRowLast: { borderBottomWidth: 0, paddingBottom: 0 },
  emptyText: {
    color: ink.muted,
    fontSize: 15,
    lineHeight: 28,
    textAlign: 'right',
  },
  badge: {
    alignSelf: 'flex-end',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: line.subtle,
    backgroundColor: surface.sunken,
  },
  badgeText: { color: ink.muted, fontSize: 12, fontWeight: '600' },
  linkText: {
    color: colors.primary[700],
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'right',
  },
})
