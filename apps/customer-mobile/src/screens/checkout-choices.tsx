import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'

import type { DeliveryWindow, PaymentMethod, QuoteSummary } from '@alo-noon/contracts'
import { colors, ink, line, surface } from '@alo-noon/design-tokens'
import { cashRefusalMessage, formatDeliveryWindow, promotionRefusalMessage } from '@alo-noon/domain'

/**
 * The three things a customer decides before they see a price.
 *
 * All three existed in the API and on the site while the phone offered none of
 * them, which meant a customer holding a discount code had to go and find a
 * browser, and one who only ever pays cash could not finish at all. On a phone
 * that is not a missing feature, it is a lost order.
 *
 * They sit above the price rather than after it. Each one changes the total, so
 * asking afterwards means either a number that moves under the customer or a
 * checkout they have to walk back through.
 *
 * None of them can fail the quote. The API answers a refused code, a filled
 * window and unavailable cash as notes on an otherwise good price, so what a
 * customer gets for a bad discount code is their real total plus a sentence
 * about the code — never an error where the price should be.
 */
export function CheckoutChoices({
  windows,
  chosenWindow,
  onChooseWindow,
  method,
  onChooseMethod,
  promotionCode,
  onPromotionCode,
  quote,
  now,
}: {
  windows: readonly DeliveryWindow[]
  /** Null is "as soon as you can" — what every order was before windows existed. */
  chosenWindow: string | null
  onChooseWindow: (startsAt: string | null) => void
  method: PaymentMethod
  onChooseMethod: (method: PaymentMethod) => void
  promotionCode: string
  onPromotionCode: (code: string) => void
  /** The last quote, for the refusals it carries. Null before pricing. */
  quote: QuoteSummary | null
  now: Date
}) {
  const bookable = windows.filter((entry) => entry.available)

  return (
    <View style={styles.choices}>
      {/*
        A branch with no recorded hours offers no windows, and the section
        disappears rather than showing an empty control that looks broken.
      */}
      {bookable.length > 0 && (
        <View style={styles.group} accessibilityRole="radiogroup">
          <Text style={styles.legend}>زمان تحویل</Text>
          <Choice
            label="در اولین فرصت"
            selected={chosenWindow === null}
            onPress={() => onChooseWindow(null)}
          />
          {bookable.map((entry) => (
            <Choice
              key={entry.startsAt}
              label={formatDeliveryWindow(entry.startsAt, entry.endsAt, now)}
              selected={chosenWindow === entry.startsAt}
              onPress={() => onChooseWindow(entry.startsAt)}
            />
          ))}
          {quote?.deliveryWindowRefusal && (
            <Refusal text="این زمان دیگر در دسترس نیست؛ زمان دیگری انتخاب کنید." />
          )}
        </View>
      )}

      {/*
        Cash is not a fallback in this market — for a great many customers it is
        the only way they will buy from a stranger's application — so it is a
        choice presented plainly, not an option hidden under the fold.

        Its refusal appears after pricing because the ceiling is a rule about
        the total, and the total does not exist until the quote does.
      */}
      <View style={styles.group} accessibilityRole="radiogroup">
        <Text style={styles.legend}>روش پرداخت</Text>
        <Choice
          label="پرداخت اینترنتی"
          selected={method === 'ONLINE_GATEWAY'}
          onPress={() => onChooseMethod('ONLINE_GATEWAY')}
        />
        <Choice
          label="نقدی به پیک"
          selected={method === 'CASH_ON_DELIVERY'}
          onPress={() => onChooseMethod('CASH_ON_DELIVERY')}
        />
        {quote?.cashOnDeliveryRefusal && (
          <Refusal text={cashRefusalMessage(quote.cashOnDeliveryRefusal)} />
        )}
      </View>

      <View style={styles.group}>
        <Text style={styles.legend}>کد تخفیف (اختیاری)</Text>
        <TextInput
          accessibilityLabel="کد تخفیف"
          value={promotionCode}
          onChangeText={onPromotionCode}
          placeholder="مثلاً NOON10"
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={64}
          // Codes are Latin and case-carrying; the RTL alignment the rest of
          // this screen uses turns them into something the customer cannot
          // proof-read against the card in their hand.
          style={[styles.input, { textAlign: 'left', writingDirection: 'ltr' }]}
        />
        {quote?.promotionRefusal && (
          <Refusal text={promotionRefusalMessage(quote.promotionRefusal) ?? 'این کد اعمال نشد.'} />
        )}
        {quote?.promotion && (
          <Text style={styles.applied} accessibilityLiveRegion="polite">
            «{quote.promotion.nameFa}» اعمال شد
            {quote.promotion.basis === 'DELIVERY_FEE' && ' — کرایه رایگان'}.
          </Text>
        )}
      </View>
    </View>
  )
}

function Choice({
  label,
  selected,
  onPress,
}: {
  label: string
  selected: boolean
  onPress: () => void
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      onPress={onPress}
      style={[styles.choice, selected && styles.choiceOn]}
    >
      {/* A ring rather than a platform radio: the same control has to look the
          same on both platforms, and this one is large enough to hit. */}
      <View style={[styles.dot, selected && styles.dotOn]} />
      <Text style={[styles.choiceLabel, selected && styles.choiceLabelOn]}>{label}</Text>
    </Pressable>
  )
}

function Refusal({ text }: { text: string }) {
  return (
    <Text style={styles.refused} accessibilityLiveRegion="polite">
      {text}
    </Text>
  )
}

const styles = StyleSheet.create({
  choices: { gap: 18 },
  group: { gap: 8 },
  legend: { color: ink.strong, fontSize: 14, fontWeight: '700', textAlign: 'right' },
  choice: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: line.subtle,
    borderRadius: 16,
    backgroundColor: surface.card,
  },
  choiceOn: { borderColor: colors.primary[700], backgroundColor: surface.sunken },
  dot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: line.subtle,
  },
  dotOn: { borderColor: colors.primary[700], borderWidth: 6 },
  choiceLabel: { flex: 1, color: ink.muted, fontSize: 15, textAlign: 'right' },
  choiceLabelOn: { color: ink.strong, fontWeight: '700' },
  input: {
    borderWidth: 1,
    borderColor: line.subtle,
    borderRadius: 16,
    backgroundColor: surface.card,
    paddingVertical: 12,
    paddingHorizontal: 14,
    fontSize: 15,
    color: ink.strong,
  },
  refused: { color: colors.error, fontSize: 13, lineHeight: 22, textAlign: 'right' },
  applied: { color: colors.primary[700], fontSize: 13, lineHeight: 22, textAlign: 'right' },
})
