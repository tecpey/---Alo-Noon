import { Pressable, Text, View } from 'react-native'

import type { AddressSummary, SessionContext } from '@alo-noon/contracts'
import { colors } from '@alo-noon/design-tokens'

import { sharedStyles } from '../theme'

/**
 * The customer's own things: where they live, and how to leave.
 *
 * The address book existed in the API from the beginning and the app never
 * showed it. A customer could add an address during checkout and then never see
 * it again — so the second order asked for it a second time, and the third a
 * third. For a service somebody uses every morning that is the difference
 * between a habit and a chore.
 */
export function AccountScreen({
  session,
  addresses,
  loading,
  selectedAddressId,
  onSelect,
  onAdd,
  onLogout,
}: {
  session: SessionContext | null
  addresses: readonly AddressSummary[]
  loading: boolean
  selectedAddressId: string | undefined
  onSelect: (addressId: string) => void
  onAdd: () => void
  onLogout: () => void
}) {
  return (
    <View style={{ gap: 20 }}>
      <View style={sharedStyles.card}>
        <Text style={sharedStyles.title}>نشانی‌های من</Text>
        <Text style={sharedStyles.subtitle}>
          نشانی‌ای که انتخاب می‌کنید، همانی است که سفارش بعدی به آن می‌رود.
        </Text>

        {loading ? (
          <Text style={sharedStyles.subtitle}>در حال خواندن نشانی‌ها…</Text>
        ) : addresses.length === 0 ? (
          <Text style={sharedStyles.emptyText}>
            هنوز نشانی‌ای ثبت نکرده‌اید. موقع سفارش، نشانی‌تان این‌جا ذخیره می‌شود تا دفعهٔ بعد
            دوباره نپرسیم.
          </Text>
        ) : (
          <View>
            {addresses.map((address, index) => (
              <AddressRow
                key={address.id}
                address={address}
                selected={address.id === selectedAddressId}
                last={index === addresses.length - 1}
                onSelect={() => onSelect(address.id)}
              />
            ))}
          </View>
        )}

        <Pressable accessibilityRole="button" onPress={onAdd} style={{ paddingVertical: 6 }}>
          <Text style={sharedStyles.linkText}>+ افزودن نشانی تازه</Text>
        </Pressable>
      </View>

      <View style={sharedStyles.card}>
        <Text style={sharedStyles.title}>حساب</Text>
        {/* The session carries no phone number — it is an authorization
            context, not a profile — so this does not pretend to show one. The
            number belongs on each address, where it is the person the courier
            actually calls. */}
        <Text style={sharedStyles.subtitle}>
          {session ? 'با شمارهٔ موبایلتان وارد شده‌اید.' : 'وارد نشده‌اید.'}
        </Text>
        <Pressable accessibilityRole="button" onPress={onLogout} style={{ paddingVertical: 6 }}>
          <Text style={[sharedStyles.linkText, { color: colors.error }]}>خروج از حساب</Text>
        </Pressable>
      </View>
    </View>
  )
}

function AddressRow({
  address,
  selected,
  last,
  onSelect,
}: {
  address: AddressSummary
  selected: boolean
  last: boolean
  onSelect: () => void
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={`${address.label}، ${address.addressLine}`}
      onPress={onSelect}
      style={[sharedStyles.listRow, last && sharedStyles.listRowLast]}
    >
      <View style={sharedStyles.rowBetween}>
        <Text style={sharedStyles.value} numberOfLines={1}>
          {address.label}
        </Text>
        {selected && (
          <View style={sharedStyles.badge}>
            <Text style={sharedStyles.badgeText}>انتخاب‌شده</Text>
          </View>
        )}
      </View>
      <Text style={sharedStyles.label} numberOfLines={2}>
        {address.addressLine}
      </Text>
      <Text style={sharedStyles.label}>
        {address.recipientName} ·{' '}
        <Text style={{ writingDirection: 'ltr' }}>{address.recipientPhone}</Text>
      </Text>
    </Pressable>
  )
}
