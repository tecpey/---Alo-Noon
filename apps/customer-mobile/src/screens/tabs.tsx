import { Pressable, StyleSheet, Text, View } from 'react-native'

import { colors, ink, line, surface } from '@alo-noon/design-tokens'

/**
 * Three tabs, hand-rolled.
 *
 * A navigation library earns its keep with deep links, a back stack, gestures
 * and screens that must survive being pushed and popped. This app has three
 * flat destinations and exactly one level below one of them, which a piece of
 * state and a back affordance handle. Adding react-navigation here would mean
 * four packages and native modules for a bar with three buttons in it.
 *
 * That calculation changes the moment a screen needs its own history, or a
 * notification has to open one directly. When it does, this is the file to
 * delete rather than the thing to extend.
 *
 * The bar sits outside the scroll view on purpose: a tab bar that scrolls away
 * is one a customer has to hunt for, and reaching the bottom of a long order
 * list is exactly when somebody wants to leave it.
 */
export type Tab = 'shop' | 'orders' | 'account'

const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'shop', label: 'نان' },
  { id: 'orders', label: 'سفارش‌ها' },
  { id: 'account', label: 'حساب' },
]

export function TabBar({
  active,
  onChange,
  /** Shown on the orders tab when something is in motion. */
  liveOrderCount,
}: {
  active: Tab
  onChange: (tab: Tab) => void
  liveOrderCount: number
}) {
  return (
    // row-reverse so the first tab sits on the right, where a Persian reader
    // starts.
    <View style={styles.bar} accessibilityRole="tablist">
      {TABS.map((tab) => {
        const selected = tab.id === active
        const badge = tab.id === 'orders' && liveOrderCount > 0 ? liveOrderCount : 0
        return (
          <Pressable
            key={tab.id}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={
              badge > 0
                ? `${tab.label}، ${badge.toLocaleString('fa-IR')} سفارش در جریان`
                : tab.label
            }
            onPress={() => onChange(tab.id)}
            style={styles.tab}
          >
            <Text style={[styles.label, selected && styles.labelActive]}>{tab.label}</Text>
            {badge > 0 && (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{badge.toLocaleString('fa-IR')}</Text>
              </View>
            )}
            {/* An underline rather than a filled pill: the bar is narrow, and a
                filled shape at this size reads as a button that is stuck. */}
            <View style={[styles.indicator, selected && styles.indicatorActive]} />
          </Pressable>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row-reverse',
    borderTopWidth: 1,
    borderTopColor: line.subtle,
    backgroundColor: surface.card,
    paddingHorizontal: 8,
    paddingTop: 8,
    // Room for the home indicator on a modern phone, so the last tab is not
    // sitting underneath it.
    paddingBottom: 20,
  },
  tab: { flex: 1, alignItems: 'center', gap: 6, paddingVertical: 6 },
  label: { color: ink.muted, fontSize: 14, fontWeight: '600' },
  labelActive: { color: colors.primary[700], fontWeight: '800' },
  indicator: { height: 2, width: 22, borderRadius: 2, backgroundColor: 'transparent' },
  indicatorActive: { backgroundColor: colors.primary[700] },
  badge: {
    position: 'absolute',
    top: 0,
    left: 22,
    minWidth: 18,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 999,
    backgroundColor: colors.primary[700],
  },
  badgeText: { color: '#FFFFFF', fontSize: 11, fontWeight: '700', textAlign: 'center' },
})
