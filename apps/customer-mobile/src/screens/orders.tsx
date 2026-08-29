import { Pressable, Text, View } from 'react-native'

import type { OrderSummary } from '@alo-noon/contracts'
import { ink, line } from '@alo-noon/design-tokens'
import { orderProgress } from '@alo-noon/domain'

import { formatRials } from '../presentation'
import { sharedStyles } from '../theme'

/**
 * Every order this customer has placed, and where each one is.
 *
 * Until now the app could place an order and then lost it: the moment the
 * screen moved on, the only record a customer had was the SMS. For a daily
 * staple that is the wrong shape — people order the same basket over and over,
 * and "what did I get last Tuesday" is a question they actually ask.
 *
 * The headline comes from the shared domain helper rather than a copy here, so
 * an order says the same thing on the phone as it does on the site. Four
 * separate states — order, payment, production, delivery — become one sentence,
 * because a customer does not want four badges, they want to know where their
 * bread is.
 */
export function OrdersScreen({
  orders,
  loading,
  onOpen,
  onRefresh,
}: {
  orders: readonly OrderSummary[]
  loading: boolean
  onOpen: (order: OrderSummary) => void
  onRefresh: () => void
}) {
  if (loading) {
    return (
      <View style={sharedStyles.card}>
        <Text style={sharedStyles.subtitle}>در حال خواندن سفارش‌ها…</Text>
      </View>
    )
  }

  if (orders.length === 0) {
    return (
      <View style={sharedStyles.card}>
        <Text style={sharedStyles.title}>هنوز سفارشی ندارید</Text>
        <Text style={sharedStyles.emptyText}>
          اولین سفارشتان که ثبت شود، این‌جا می‌ماند — با وضعیتش، و برای اینکه بعداً بتوانید همان را
          دوباره بگیرید.
        </Text>
      </View>
    )
  }

  return (
    <View style={sharedStyles.card}>
      <View style={sharedStyles.rowBetween}>
        <Text style={sharedStyles.title}>سفارش‌های من</Text>
        <Pressable accessibilityRole="button" onPress={onRefresh}>
          <Text style={sharedStyles.linkText}>به‌روزرسانی</Text>
        </Pressable>
      </View>

      <View>
        {orders.map((order, index) => (
          <OrderRow
            key={order.id}
            order={order}
            last={index === orders.length - 1}
            onOpen={() => onOpen(order)}
          />
        ))}
      </View>
    </View>
  )
}

function OrderRow({
  order,
  last,
  onOpen,
}: {
  order: OrderSummary
  last: boolean
  onOpen: () => void
}) {
  const progress = orderProgress(order)
  return (
    <Pressable
      accessibilityRole="button"
      // Reads as one sentence to a screen reader rather than four fragments.
      accessibilityLabel={`سفارش ${order.publicId}، ${progress.headline}`}
      onPress={onOpen}
      style={[sharedStyles.listRow, last && sharedStyles.listRowLast]}
    >
      <View style={sharedStyles.rowBetween}>
        <Text style={sharedStyles.value} numberOfLines={1}>
          {progress.headline}
        </Text>
        <Text style={sharedStyles.value}>{formatRials(order.total.amount)}</Text>
      </View>
      <View style={sharedStyles.rowBetween}>
        <Text style={sharedStyles.label}>{orderDateLabel(order.createdAt)}</Text>
        {/* The public id is Latin and is what a customer reads out on the
            phone to support, so it stays left-to-right and monospaced-ish. */}
        <Text style={[sharedStyles.label, { writingDirection: 'ltr' }]}>{order.publicId}</Text>
      </View>
    </Pressable>
  )
}

/**
 * One order in full: what was in it, what it cost, and where it is.
 *
 * A back affordance rather than a navigation stack. One level deep does not
 * earn a navigation library, and the phone's own back gesture is handled by the
 * caller.
 */
export function OrderDetailScreen({
  order,
  onBack,
  onReorder,
  reordering,
}: {
  order: OrderSummary
  onBack: () => void
  onReorder: () => void
  reordering: boolean
}) {
  const progress = orderProgress(order)
  return (
    <View style={sharedStyles.card}>
      <View style={sharedStyles.rowBetween}>
        <Text style={sharedStyles.title}>سفارش</Text>
        <Pressable accessibilityRole="button" onPress={onBack}>
          <Text style={sharedStyles.linkText}>بازگشت</Text>
        </Pressable>
      </View>

      <View style={sharedStyles.badge}>
        <Text style={sharedStyles.badgeText}>{progress.headline}</Text>
      </View>

      <View style={sharedStyles.rowBetween}>
        <Text style={sharedStyles.label}>شمارهٔ سفارش</Text>
        <Text style={[sharedStyles.value, { writingDirection: 'ltr' }]}>{order.publicId}</Text>
      </View>
      <View style={sharedStyles.rowBetween}>
        <Text style={sharedStyles.label}>تاریخ</Text>
        <Text style={sharedStyles.value}>{orderDateLabel(order.createdAt)}</Text>
      </View>

      <View style={{ borderTopWidth: 1, borderTopColor: line.subtle, paddingTop: 12, gap: 8 }}>
        {order.items.map((item) => (
          <View key={item.id} style={sharedStyles.rowBetween}>
            <Text style={sharedStyles.value} numberOfLines={1}>
              {item.nameFaSnapshot}
            </Text>
            <Text style={sharedStyles.label}>
              {item.quantity.toLocaleString('fa-IR')} × {formatRials(item.unitPrice.amount)}
            </Text>
          </View>
        ))}
      </View>

      <View style={{ borderTopWidth: 1, borderTopColor: line.subtle, paddingTop: 12, gap: 8 }}>
        <Money label="جمع اقلام" amount={order.subtotal.amount} />
        <Money label="کرایهٔ تحویل" amount={order.deliveryFee.amount} />
        {/* Only shown when there is one. A zero discount line invites the
            question "why is my discount nothing". */}
        {order.discount.amount !== '0' && <Money label="تخفیف" amount={order.discount.amount} />}
        <View style={sharedStyles.rowBetween}>
          <Text style={sharedStyles.value}>مجموع</Text>
          <Text style={[sharedStyles.value, { color: ink.strong, fontSize: 17 }]}>
            {formatRials(order.total.amount)}
          </Text>
        </View>
      </View>

      <Pressable
        accessibilityRole="button"
        disabled={reordering}
        onPress={onReorder}
        style={{ paddingVertical: 8 }}
      >
        <Text style={sharedStyles.linkText}>
          {reordering ? 'در حال آماده‌سازی…' : 'همین را دوباره سفارش بده'}
        </Text>
      </Pressable>
    </View>
  )
}

function Money({ label, amount }: { label: string; amount: string }) {
  return (
    <View style={sharedStyles.rowBetween}>
      <Text style={sharedStyles.label}>{label}</Text>
      <Text style={sharedStyles.label}>{formatRials(amount)}</Text>
    </View>
  )
}

/**
 * The Persian calendar date, because that is the one the customer keeps.
 *
 * Falls back to the raw value rather than throwing: a date that cannot be
 * formatted should still show something, and an order list that crashes on one
 * bad timestamp is worse than one row reading oddly.
 */
function orderDateLabel(iso: string): string {
  try {
    return new Intl.DateTimeFormat('fa-IR', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(iso))
  } catch {
    return iso
  }
}
