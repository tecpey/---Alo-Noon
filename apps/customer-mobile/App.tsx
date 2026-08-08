import { useEffect, useMemo, useState } from 'react'
import * as Location from 'expo-location'
import { StatusBar } from 'expo-status-bar'
import {
  ActivityIndicator,
  Linking,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'

import type {
  ActiveCitySummary,
  AddressSummary,
  CartSummary,
  OrderSummary,
  PaymentExecutionSummary,
  PaymentSummary,
  ProductSummary,
  QuoteSummary,
  SessionContext,
} from '@alo-noon/contracts'
import { colors } from '@alo-noon/design-tokens'

import { createCustomerApiClient, CustomerApiError, type CustomerApiClient } from './src/api'
import { customerCopy } from './src/copy'
import {
  formatRials,
  normalizeIranianMobile,
  normalizeOtpCode,
  productPromiseLabel,
  serviceabilityMessage,
} from './src/presentation'

type Screen = 'boot' | 'phone' | 'otp' | 'location' | 'catalog'

const apiBaseUrl = process.env['EXPO_PUBLIC_API_BASE_URL']

export default function App() {
  const api = useMemo(() => {
    if (!apiBaseUrl) return null
    try {
      return createCustomerApiClient(apiBaseUrl)
    } catch {
      return null
    }
  }, [])
  const [screen, setScreen] = useState<Screen>('boot')
  const [session, setSession] = useState<SessionContext | null>(null)
  const [cities, setCities] = useState<ActiveCitySummary[]>([])
  const [selectedCityId, setSelectedCityId] = useState<string>()
  const [operationalZoneId, setOperationalZoneId] = useState<string>()
  const [products, setProducts] = useState<ProductSummary[]>([])
  const [cart, setCart] = useState<CartSummary | null>(null)
  const [quote, setQuote] = useState<QuoteSummary | null>(null)
  const [order, setOrder] = useState<OrderSummary | null>(null)
  const [addresses, setAddresses] = useState<AddressSummary[]>([])
  const [selectedAddressId, setSelectedAddressId] = useState<string>()
  const [coordinates, setCoordinates] = useState<{ latitude: number; longitude: number }>()
  const [addressLabel, setAddressLabel] = useState('خانه')
  const [recipientName, setRecipientName] = useState('')
  const [recipientPhone, setRecipientPhone] = useState('')
  const [addressLine, setAddressLine] = useState('')
  const [addressCommandKey, setAddressCommandKey] = useState<string>()
  const [quoteCommandKey, setQuoteCommandKey] = useState<string>()
  const [orderCommandKey, setOrderCommandKey] = useState<string>()
  const [payment, setPayment] = useState<PaymentSummary | null>(null)
  const [execution, setExecution] = useState<PaymentExecutionSummary | null>(null)
  const [paymentCommandKey, setPaymentCommandKey] = useState<string>()
  const [phone, setPhone] = useState('')
  const [otpCommand, setOtpCommand] = useState<{ mobileE164: string; idempotencyKey: string }>()
  const [otp, setOtp] = useState('')
  const [challengeId, setChallengeId] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string>()

  useEffect(() => {
    if (!api) {
      setMessage('نشانی API برنامه تنظیم نشده است.')
      return
    }

    let active = true
    void api
      .getSession()
      .then(async (currentSession) => {
        if (!active) return
        setSession(currentSession)
        if (!currentSession) {
          setScreen('phone')
          return
        }
        setScreen('location')
        try {
          await Promise.all([
            loadCities(api, active),
            loadCart(api, active),
            loadAddresses(api, active),
          ])
        } catch (error) {
          if (active) setMessage(errorMessage(error))
        }
      })
      .catch((error: unknown) => {
        if (!active) return
        setMessage(errorMessage(error))
        setScreen('phone')
      })

    async function loadCities(client: CustomerApiClient, stillActive: boolean) {
      const activeCities = await client.listActiveCities()
      if (!stillActive) return
      setCities(activeCities)
      setSelectedCityId(activeCities[0]?.id)
    }

    async function loadCart(client: CustomerApiClient, stillActive: boolean) {
      const activeCart = await client.getCart()
      if (stillActive) setCart(activeCart)
    }

    async function loadAddresses(client: CustomerApiClient, stillActive: boolean) {
      const saved = await client.listAddresses()
      if (!stillActive) return
      setAddresses(saved)
      setSelectedAddressId(saved[0]?.id)
    }

    return () => {
      active = false
    }
  }, [api])

  const requestOtp = async () => {
    if (!api || busy) return
    const mobileE164 = normalizeIranianMobile(phone)
    if (!mobileE164) {
      setMessage('شماره موبایل معتبر ایران وارد کنید.')
      return
    }

    setBusy(true)
    setMessage(undefined)
    const command =
      otpCommand?.mobileE164 === mobileE164
        ? otpCommand
        : { mobileE164, idempotencyKey: commandKey('otp') }
    setOtpCommand(command)
    try {
      const challenge = await api.requestOtp(mobileE164, command.idempotencyKey)
      setChallengeId(challenge.challengeId)
      setOtp('')
      setOtpCommand(undefined)
      setScreen('otp')
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const verifyOtp = async () => {
    if (!api || !challengeId || busy) return
    const normalizedOtp = normalizeOtpCode(otp)
    if (!normalizedOtp) {
      setMessage('کد تأیید باید دقیقاً شش رقم باشد.')
      return
    }

    setBusy(true)
    setMessage(undefined)
    try {
      const currentSession = await api.verifyOtp(challengeId, normalizedOtp)
      setSession(currentSession)
      setChallengeId(undefined)
      setPhone('')
      setOtp('')
      setScreen('location')
      try {
        const activeCities = await api.listActiveCities()
        const [activeCart, savedAddresses] = await Promise.all([api.getCart(), api.listAddresses()])
        setCities(activeCities)
        setSelectedCityId(activeCities[0]?.id)
        setCart(activeCart)
        setAddresses(savedAddresses)
        setSelectedAddressId(savedAddresses[0]?.id)
      } catch (error) {
        setMessage(errorMessage(error))
      }
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const refreshCities = async () => {
    if (!api || busy) return
    setBusy(true)
    setMessage(undefined)
    try {
      const activeCities = await api.listActiveCities()
      setCities(activeCities)
      setSelectedCityId(activeCities[0]?.id)
    } catch (error) {
      handleAuthenticatedError(error)
    } finally {
      setBusy(false)
    }
  }

  const locateAndLoad = async () => {
    if (!api || !selectedCityId || busy) return
    setBusy(true)
    setMessage(undefined)
    try {
      const permission = await Location.requestForegroundPermissionsAsync()
      if (permission.status !== Location.PermissionStatus.GRANTED) {
        setMessage('اجازه دسترسی به موقعیت داده نشد؛ برای بررسی محدوده باید آن را فعال کنید.')
        return
      }

      const current = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      })
      const decision = await api.checkServiceability({
        cityId: selectedCityId,
        latitude: current.coords.latitude,
        longitude: current.coords.longitude,
      })
      if (!decision.serviceable || !decision.operationalZoneId) {
        setMessage(serviceabilityMessage(decision.reason))
        return
      }

      const catalog = await api.listCatalog({
        cityId: selectedCityId,
        operationalZoneId: decision.operationalZoneId,
      })
      setOperationalZoneId(decision.operationalZoneId)
      setSelectedAddressId(
        addresses.find(
          (address) =>
            address.cityId === selectedCityId &&
            address.operationalZoneId === decision.operationalZoneId,
        )?.id,
      )
      setCoordinates({ latitude: current.coords.latitude, longitude: current.coords.longitude })
      setProducts(catalog)
      setQuote(null)
      setScreen('catalog')
    } catch (error) {
      handleAuthenticatedError(error)
    } finally {
      setBusy(false)
    }
  }

  const addProduct = async (product: ProductSummary) => {
    if (!api || !selectedCityId || !operationalZoneId || busy) return
    const currentQuantity =
      cart?.items.find((item) => item.bakeryProductOfferingId === product.offeringId)?.quantity ?? 0
    setBusy(true)
    setMessage(undefined)
    setQuote(null)
    setOrder(null)
    resetPayment()
    try {
      const updated = await api.setCartItem(product.offeringId, {
        cityId: selectedCityId,
        operationalZoneId,
        quantity: currentQuantity + 1,
        ...(cart && { expectedCartVersion: cart.version }),
      })
      setCart(updated)
    } catch (error) {
      handleAuthenticatedError(error)
    } finally {
      setBusy(false)
    }
  }

  const removeCartItem = async (offeringId: string) => {
    if (!api || !cart || busy) return
    setBusy(true)
    setMessage(undefined)
    setQuote(null)
    setOrder(null)
    resetPayment()
    try {
      setCart(await api.removeCartItem(offeringId, cart.version))
    } catch (error) {
      handleAuthenticatedError(error)
    } finally {
      setBusy(false)
    }
  }

  const createAddress = async () => {
    if (!api || !selectedCityId || !coordinates || busy) return
    const normalizedPhone = normalizeIranianMobile(recipientPhone)
    if (!normalizedPhone || recipientName.trim().length < 2 || addressLine.trim().length < 10) {
      setMessage('نام گیرنده، شماره موبایل و نشانی کامل را وارد کنید.')
      return
    }
    const idempotencyKey = addressCommandKey ?? commandKey('mobile-address')
    setAddressCommandKey(idempotencyKey)
    setBusy(true)
    setMessage(undefined)
    try {
      const created = await api.createAddress({
        cityId: selectedCityId,
        label: addressLabel.trim(),
        recipientName: recipientName.trim(),
        recipientPhone: normalizedPhone,
        addressLine: addressLine.trim(),
        latitude: coordinates.latitude,
        longitude: coordinates.longitude,
        idempotencyKey,
      })
      setAddresses((current) => [created, ...current.filter((item) => item.id !== created.id)])
      setSelectedAddressId(created.id)
      setAddressCommandKey(undefined)
    } catch (error) {
      handleAuthenticatedError(error)
    } finally {
      setBusy(false)
    }
  }

  const createQuote = async () => {
    if (!api || !cart || !selectedAddressId || cart.items.length === 0 || busy) return
    const idempotencyKey = quoteCommandKey ?? commandKey('mobile-quote')
    setQuoteCommandKey(idempotencyKey)
    setBusy(true)
    setMessage(undefined)
    try {
      setQuote(await api.createQuote(selectedAddressId, cart.version, idempotencyKey))
      setOrder(null)
      resetPayment()
      resetPayment()
      setQuoteCommandKey(undefined)
    } catch (error) {
      handleAuthenticatedError(error)
    } finally {
      setBusy(false)
    }
  }

  const createOrder = async () => {
    if (!api || !quote || busy) return
    const idempotencyKey = orderCommandKey ?? commandKey('mobile-order')
    setOrderCommandKey(idempotencyKey)
    setBusy(true)
    setMessage(undefined)
    try {
      setOrder(await api.createOrder(quote.id, idempotencyKey))
      setOrderCommandKey(undefined)
    } catch (error) {
      handleAuthenticatedError(error)
    } finally {
      setBusy(false)
    }
  }

  const resetPayment = () => {
    setPayment(null)
    setExecution(null)
    setPaymentCommandKey(undefined)
  }

  /**
   * Opens the payment and asks the gateway for a page to send the customer to.
   *
   * Both steps share one idempotency key so a double tap replays onto the same
   * payment and the same attempt rather than opening a second of either. The
   * key is only cleared once a URL is in hand: if the second call fails, the
   * retry must reuse it.
   */
  const startPayment = async () => {
    if (!api || !order || busy) return
    const idempotencyKey = paymentCommandKey ?? commandKey('mobile-payment')
    setPaymentCommandKey(idempotencyKey)
    setBusy(true)
    setMessage(undefined)
    try {
      const opened = payment ?? (await api.startPayment(order.id, idempotencyKey))
      setPayment(opened)
      const result = await api.initializePayment(opened.id, idempotencyKey)
      setExecution(result)
      if (result.customerAction) {
        setPaymentCommandKey(undefined)
        await Linking.openURL(result.customerAction.url)
      } else {
        // No page to send them to means the gateway refused before the customer
        // ever saw it. Its own message is the useful one when there is one.
        setMessage(
          result.failure?.customerMessageKey
            ? customerCopy.paymentRefused
            : customerCopy.paymentUnavailable,
        )
      }
    } catch (error) {
      handleAuthenticatedError(error)
    } finally {
      setBusy(false)
    }
  }

  /**
   * Asks the API what actually happened, after the customer comes back.
   *
   * Deliberately not driven by the return URL: every parameter on it is
   * attacker-controllable, and the verdict comes from the gateway's own
   * server-to-server answer. Settlement may not have finished when they return,
   * which is why this is a button they can press again rather than a one-shot
   * read.
   */
  const refreshPayment = async () => {
    if (!api || !payment || busy) return
    setBusy(true)
    setMessage(undefined)
    try {
      setPayment(await api.readPayment(payment.id))
    } catch (error) {
      handleAuthenticatedError(error)
    } finally {
      setBusy(false)
    }
  }

  const logout = async () => {
    if (!api || busy) return
    setBusy(true)
    setMessage(undefined)
    try {
      await api.logout()
      setSession(null)
      setCities([])
      setSelectedCityId(undefined)
      setOperationalZoneId(undefined)
      setProducts([])
      setCart(null)
      setQuote(null)
      setOrder(null)
      resetPayment()
      resetPayment()
      setAddresses([])
      setSelectedAddressId(undefined)
      setCoordinates(undefined)
      setAddressCommandKey(undefined)
      setQuoteCommandKey(undefined)
      setOrderCommandKey(undefined)
      setChallengeId(undefined)
      setScreen('phone')
      setMessage(undefined)
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const handleAuthenticatedError = (error: unknown) => {
    if (error instanceof CustomerApiError && error.status === 401) {
      setSession(null)
      setCities([])
      setSelectedCityId(undefined)
      setOperationalZoneId(undefined)
      setProducts([])
      setCart(null)
      setQuote(null)
      setOrder(null)
      resetPayment()
      resetPayment()
      setAddresses([])
      setSelectedAddressId(undefined)
      setCoordinates(undefined)
      setAddressCommandKey(undefined)
      setQuoteCommandKey(undefined)
      setOrderCommandKey(undefined)
      setChallengeId(undefined)
      setScreen('phone')
    }
    setMessage(errorMessage(error))
  }

  if (!api) {
    return (
      <Shell>
        <MessageCard title="تنظیمات برنامه کامل نیست" message={message ?? ''} />
      </Shell>
    )
  }

  return (
    <Shell>
      {screen === 'boot' && <Loading label="در حال بررسی نشست امن…" />}

      {screen === 'phone' && (
        <AuthCard
          title={customerCopy.phoneTitle}
          hint={customerCopy.phoneHint}
          value={phone}
          placeholder="۰۹۱۱۱۲۳۴۵۶۷"
          keyboardType="phone-pad"
          busy={busy}
          actionLabel="دریافت کد تأیید"
          message={message}
          onChangeText={setPhone}
          onSubmit={requestOtp}
        />
      )}

      {screen === 'otp' && (
        <AuthCard
          title={customerCopy.otpTitle}
          hint="کد شش‌رقمی ارسال‌شده را وارد کنید."
          value={otp}
          placeholder="۱۲۳۴۵۶"
          keyboardType="number-pad"
          maxLength={6}
          busy={busy}
          actionLabel="تأیید و ورود"
          secondaryLabel="اصلاح شماره"
          message={message}
          onChangeText={setOtp}
          onSubmit={verifyOtp}
          onSecondary={() => {
            setChallengeId(undefined)
            setMessage(undefined)
            setScreen('phone')
          }}
        />
      )}

      {screen === 'location' && (
        <View style={styles.card}>
          <Header session={session} onLogout={logout} />
          <Text style={styles.title}>{customerCopy.locationTitle}</Text>
          <Text style={styles.subtitle}>{customerCopy.locationHint}</Text>
          {cities.length === 0 ? (
            <>
              <Text style={styles.emptyText}>{customerCopy.noCities}</Text>
              <PrimaryButton label="تلاش دوباره" busy={busy} onPress={refreshCities} />
            </>
          ) : (
            <>
              <Text style={styles.fieldLabel}>شهر</Text>
              <View style={styles.cityList}>
                {cities.map((city) => (
                  <Pressable
                    key={city.id}
                    accessibilityRole="button"
                    accessibilityState={{ selected: selectedCityId === city.id }}
                    style={[styles.cityChip, selectedCityId === city.id && styles.cityChipSelected]}
                    onPress={() => setSelectedCityId(city.id)}
                  >
                    <Text
                      style={[
                        styles.cityChipText,
                        selectedCityId === city.id && styles.cityChipTextSelected,
                      ]}
                    >
                      {city.nameFa}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <PrimaryButton
                label="بررسی موقعیت و نمایش محصولات"
                busy={busy}
                disabled={!selectedCityId}
                onPress={locateAndLoad}
              />
            </>
          )}
          {message && <InlineMessage text={message} />}
        </View>
      )}

      {screen === 'catalog' && (
        <View style={styles.catalogPanel}>
          <Header session={session} onLogout={logout} />
          <Text style={styles.title}>{customerCopy.title}</Text>
          <Text style={styles.subtitle}>{customerCopy.subtitle}</Text>
          {products.length === 0 ? (
            <Text style={styles.emptyText}>{customerCopy.emptyCatalog}</Text>
          ) : (
            <View style={styles.productList}>
              {products.map((product) => (
                <ProductCard
                  key={product.offeringId}
                  product={product}
                  busy={busy}
                  onAdd={() => void addProduct(product)}
                />
              ))}
            </View>
          )}
          {coordinates && selectedCityId && (
            <AddressCheckoutCard
              addresses={addresses.filter(
                (address) =>
                  address.cityId === selectedCityId &&
                  address.operationalZoneId === operationalZoneId,
              )}
              selectedAddressId={selectedAddressId}
              addressLabel={addressLabel}
              recipientName={recipientName}
              recipientPhone={recipientPhone}
              addressLine={addressLine}
              busy={busy}
              onSelect={setSelectedAddressId}
              onAddressLabel={setAddressLabel}
              onRecipientName={setRecipientName}
              onRecipientPhone={setRecipientPhone}
              onAddressLine={setAddressLine}
              onCreate={() => void createAddress()}
            />
          )}
          {cart && (
            <CartCard
              cart={cart}
              quote={quote}
              order={order}
              payment={payment}
              awaitingReturn={Boolean(execution?.customerAction)}
              addressSelected={Boolean(selectedAddressId)}
              busy={busy}
              onRemove={(offeringId) => void removeCartItem(offeringId)}
              onQuote={() => void createQuote()}
              onOrder={() => void createOrder()}
              onPay={() => void startPayment()}
              onRefreshPayment={() => void refreshPayment()}
            />
          )}
          {message && <InlineMessage text={message} />}
          <Pressable
            accessibilityRole="button"
            style={styles.secondaryButton}
            onPress={() => {
              setMessage(undefined)
              setOperationalZoneId(undefined)
              setQuote(null)
              setOrder(null)
              resetPayment()
              resetPayment()
              setScreen('location')
            }}
          >
            <Text style={styles.secondaryButtonText}>تغییر محدوده</Text>
          </Pressable>
        </View>
      )}
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
        <View style={styles.brandLockup}>
          <Text style={styles.brand}>الو نون</Text>
          <Text style={styles.brandCaption}>انتخاب روشن برای نان روزانه</Text>
        </View>
        {children}
      </ScrollView>
      <StatusBar style="dark" />
    </SafeAreaView>
  )
}

function Header({ session, onLogout }: { session: SessionContext | null; onLogout: () => void }) {
  if (!session) return null
  return (
    <View style={styles.sessionRow}>
      <View style={styles.sessionBadge}>
        <Text style={styles.sessionBadgeText}>نشست امن فعال</Text>
      </View>
      <Pressable accessibilityRole="button" onPress={onLogout}>
        <Text style={styles.logoutText}>خروج</Text>
      </Pressable>
    </View>
  )
}

function AuthCard({
  title,
  hint,
  value,
  placeholder,
  keyboardType,
  maxLength,
  busy,
  actionLabel,
  secondaryLabel,
  message,
  onChangeText,
  onSubmit,
  onSecondary,
}: {
  title: string
  hint: string
  value: string
  placeholder: string
  keyboardType: 'phone-pad' | 'number-pad'
  maxLength?: number
  busy: boolean
  actionLabel: string
  secondaryLabel?: string
  message?: string
  onChangeText: (value: string) => void
  onSubmit: () => void
  onSecondary?: () => void
}) {
  return (
    <View style={styles.card}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.subtitle}>{hint}</Text>
      <TextInput
        accessibilityLabel={title}
        autoComplete={keyboardType === 'phone-pad' ? 'tel' : 'one-time-code'}
        keyboardType={keyboardType}
        maxLength={maxLength}
        placeholder={placeholder}
        placeholderTextColor={colors.neutral[400]}
        style={styles.input}
        textAlign="left"
        value={value}
        onChangeText={onChangeText}
        onSubmitEditing={onSubmit}
      />
      <PrimaryButton label={actionLabel} busy={busy} onPress={onSubmit} />
      {secondaryLabel && onSecondary && (
        <Pressable accessibilityRole="button" style={styles.secondaryButton} onPress={onSecondary}>
          <Text style={styles.secondaryButtonText}>{secondaryLabel}</Text>
        </Pressable>
      )}
      {message && <InlineMessage text={message} />}
    </View>
  )
}

function PrimaryButton({
  label,
  busy,
  disabled = false,
  onPress,
}: {
  label: string
  busy: boolean
  disabled?: boolean
  onPress: () => void
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ busy, disabled: busy || disabled }}
      disabled={busy || disabled}
      style={[styles.primaryButton, (busy || disabled) && styles.buttonDisabled]}
      onPress={onPress}
    >
      {busy ? (
        <ActivityIndicator color={colors.neutral[50]} />
      ) : (
        <Text style={styles.primaryButtonText}>{label}</Text>
      )}
    </Pressable>
  )
}

function ProductCard({
  product,
  busy,
  onAdd,
}: {
  product: ProductSummary
  busy: boolean
  onAdd: () => void
}) {
  const promise = productPromiseLabel(product)
  const isFresh =
    product.fulfillmentClass === 'SIGNATURE_FRESH' && product.freshnessClaim === 'FRESHLY_PRODUCED'
  return (
    <View style={styles.productCard}>
      <View style={styles.productTopRow}>
        <Text style={styles.productName}>{product.nameFa}</Text>
        <View style={[styles.promiseBadge, isFresh && styles.freshBadge]}>
          <Text style={[styles.promiseText, isFresh && styles.freshText]}>{promise}</Text>
        </View>
      </View>
      <Text style={styles.price}>{formatRials(product.price.amount)}</Text>
      <PrimaryButton label="افزودن به سبد" busy={busy} onPress={onAdd} />
    </View>
  )
}

function AddressCheckoutCard({
  addresses,
  selectedAddressId,
  addressLabel,
  recipientName,
  recipientPhone,
  addressLine,
  busy,
  onSelect,
  onAddressLabel,
  onRecipientName,
  onRecipientPhone,
  onAddressLine,
  onCreate,
}: {
  addresses: AddressSummary[]
  selectedAddressId?: string
  addressLabel: string
  recipientName: string
  recipientPhone: string
  addressLine: string
  busy: boolean
  onSelect: (id: string) => void
  onAddressLabel: (value: string) => void
  onRecipientName: (value: string) => void
  onRecipientPhone: (value: string) => void
  onAddressLine: (value: string) => void
  onCreate: () => void
}) {
  return (
    <View style={styles.cartCard} accessibilityLanguage="fa">
      <Text style={styles.cartTitle}>نشانی تحویل</Text>
      {addresses.map((address) => (
        <Pressable
          key={address.id}
          accessibilityRole="radio"
          accessibilityState={{ selected: selectedAddressId === address.id }}
          style={[styles.addressOption, selectedAddressId === address.id && styles.addressSelected]}
          onPress={() => onSelect(address.id)}
        >
          <Text style={styles.cartItemName}>{address.label}</Text>
          <Text style={styles.cartItemMeta}>{address.addressLine}</Text>
        </Pressable>
      ))}
      <Text style={styles.fieldLabel}>افزودن نشانی تازه با موقعیت تأییدشده</Text>
      <TextInput
        accessibilityLabel="عنوان نشانی"
        value={addressLabel}
        onChangeText={onAddressLabel}
        placeholder="خانه"
        style={[styles.input, styles.rtlInput]}
      />
      <TextInput
        accessibilityLabel="نام گیرنده"
        value={recipientName}
        onChangeText={onRecipientName}
        placeholder="نام گیرنده"
        style={[styles.input, styles.rtlInput]}
      />
      <TextInput
        accessibilityLabel="شماره موبایل گیرنده"
        value={recipientPhone}
        onChangeText={onRecipientPhone}
        keyboardType="phone-pad"
        placeholder="۰۹۱۱۱۲۳۴۵۶۷"
        style={styles.input}
        textAlign="left"
      />
      <TextInput
        accessibilityLabel="نشانی کامل"
        value={addressLine}
        onChangeText={onAddressLine}
        placeholder="نشانی کامل برای تحویل"
        multiline
        style={[styles.input, styles.rtlInput]}
      />
      <PrimaryButton label="ذخیره نشانی" busy={busy} onPress={onCreate} />
    </View>
  )
}

function CartCard({
  cart,
  quote,
  order,
  payment,
  awaitingReturn,
  addressSelected,
  busy,
  onRemove,
  onQuote,
  onOrder,
  onPay,
  onRefreshPayment,
}: {
  cart: CartSummary
  quote: QuoteSummary | null
  order: OrderSummary | null
  payment: PaymentSummary | null
  /** True once the customer has been handed a gateway page to open. */
  awaitingReturn: boolean
  addressSelected: boolean
  busy: boolean
  onRemove: (offeringId: string) => void
  onQuote: () => void
  onOrder: () => void
  onPay: () => void
  onRefreshPayment: () => void
}) {
  return (
    <View style={styles.cartCard}>
      <View style={styles.cartTitleRow}>
        <Text style={styles.cartVersion}>نسخه {cart.version.toLocaleString('fa-IR')}</Text>
        <Text style={styles.cartTitle}>سبد خرید سروری</Text>
      </View>
      {cart.items.length === 0 ? (
        <Text style={styles.emptyText}>سبد خرید خالی است.</Text>
      ) : (
        cart.items.map((item) => (
          <View key={item.id} style={styles.cartItem}>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() => onRemove(item.bakeryProductOfferingId)}
            >
              <Text style={styles.removeText}>حذف</Text>
            </Pressable>
            <View style={styles.cartItemCopy}>
              <Text style={styles.cartItemName}>{item.nameFa}</Text>
              <Text style={styles.cartItemMeta}>
                {item.quantity.toLocaleString('fa-IR')} عدد · {formatRials(item.lineTotal.amount)}
              </Text>
            </View>
          </View>
        ))
      )}
      <View style={styles.totalRow}>
        <Text style={styles.price}>{formatRials(cart.subtotal.amount)}</Text>
        <Text style={styles.totalLabel}>جمع سبد</Text>
      </View>
      <PrimaryButton
        label="دریافت قیمت نهایی"
        busy={busy}
        disabled={cart.items.length === 0 || !addressSelected}
        onPress={onQuote}
      />
      {quote && (
        <View style={styles.quoteCard}>
          <Text style={styles.quoteTitle}>قیمت تا زمان درج‌شده معتبر است</Text>
          <Text style={styles.quoteMeta}>
            انقضا: {new Date(quote.expiresAt).toLocaleTimeString('fa-IR')}
          </Text>
          <Text style={styles.quoteMeta}>هزینه ارسال: {formatRials(quote.deliveryFee.amount)}</Text>
          <Text style={styles.quoteTotal}>{formatRials(quote.total.amount)}</Text>
          <Text style={styles.quoteNotice}>
            مبلغ و نشانی این قیمت در سرور ثبت شده‌اند. پرداخت هنوز آغاز نمی‌شود.
          </Text>
          {!order && <PrimaryButton label="ثبت سفارش" busy={busy} onPress={onOrder} />}
        </View>
      )}
      {order && (
        <View accessibilityLiveRegion="polite" style={styles.orderConfirmation}>
          <Text style={styles.quoteTitle}>سفارش با موفقیت ثبت شد</Text>
          <Text style={styles.quoteMeta}>شماره سفارش: {order.publicId}</Text>
          <Text style={styles.quoteMeta}>وضعیت: {PAYMENT_STATE_FA[payment?.state ?? 'NONE']}</Text>
          <Text style={styles.quoteTotal}>{formatRials(order.total.amount)}</Text>

          {payment?.state === 'CAPTURED' ? (
            <Text style={styles.quoteNotice}>پرداخت شما تأیید شد.</Text>
          ) : (
            <>
              {awaitingReturn && (
                <Text style={styles.quoteNotice}>{customerCopy.paymentReturn}</Text>
              )}
              <PrimaryButton
                label={awaitingReturn ? 'پرداخت دوباره' : 'پرداخت'}
                busy={busy}
                onPress={onPay}
              />
              {payment && (
                <PrimaryButton label="بررسی وضعیت پرداخت" busy={busy} onPress={onRefreshPayment} />
              )}
            </>
          )}
        </View>
      )}
    </View>
  )
}

/**
 * What a payment state means to the person who just paid.
 *
 * `AUTHORIZED` is not "paid": the gateway has agreed but the money has not been
 * captured, and telling a customer they are done before it has would be a lie
 * the ledger disagrees with.
 */
const PAYMENT_STATE_FA: Readonly<Record<string, string>> = {
  NONE: 'در انتظار پرداخت',
  CREATED: 'در انتظار پرداخت',
  PENDING: 'در حال بررسی با درگاه',
  AUTHORIZED: 'در حال بررسی با درگاه',
  CAPTURED: 'پرداخت‌شده',
  FAILED: 'پرداخت ناموفق',
}

function InlineMessage({ text }: { text: string }) {
  return (
    <View accessibilityLiveRegion="polite" style={styles.message}>
      <Text style={styles.messageText}>{text}</Text>
    </View>
  )
}

function Loading({ label }: { label: string }) {
  return (
    <View style={styles.card}>
      <ActivityIndicator color={colors.primary[700]} />
      <Text style={styles.loadingText}>{label}</Text>
    </View>
  )
}

function MessageCard({ title, message }: { title: string; message: string }) {
  return (
    <View style={styles.card}>
      <Text style={styles.title}>{title}</Text>
      <InlineMessage text={message} />
    </View>
  )
}

function commandKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 12).padEnd(10, '0')}`
}

function errorMessage(error: unknown): string {
  if (!(error instanceof CustomerApiError)) {
    return 'ارتباط با سرویس برقرار نشد؛ دوباره تلاش کنید.'
  }

  switch (error.code) {
    case 'OTP_DELIVERY_UNAVAILABLE':
      return 'ارسال پیامک هنوز فعال نشده است؛ کمی بعد دوباره تلاش کنید.'
    case 'OTP_INVALID_OR_EXPIRED':
      return 'کد واردشده نادرست یا منقضی شده است.'
    case 'SESSION_UNAUTHORIZED':
      return 'نشست شما منقضی شده است؛ دوباره وارد شوید.'
    case 'CART_VERSION_CONFLICT':
      return 'سبد خرید تغییر کرده است؛ صفحه را تازه کنید و دوباره تلاش کنید.'
    case 'CART_CONTEXT_MISMATCH':
      return 'محصولات یک سبد باید از یک محدوده و یک شعبه باشند.'
    case 'OFFERING_NOT_FOUND':
    case 'OFFERING_UNAVAILABLE':
      return 'این محصول فعلاً برای سفارش در دسترس نیست.'
    case 'CAPACITY_UNAVAILABLE':
      return 'ظرفیت این شعبه فعلاً تکمیل است.'
    case 'ADDRESS_NOT_SERVICEABLE':
      return 'این نشانی خارج از محدوده تحویل است.'
    case 'ADDRESS_CONTEXT_MISMATCH':
      return 'نشانی انتخابی با محدوده این سبد یکسان نیست.'
    case 'IDEMPOTENCY_KEY_CONFLICT':
      return 'درخواست تکراری با اطلاعات متفاوت دریافت شد؛ دوباره آغاز کنید.'
    case 'QUOTE_EXPIRED':
    case 'QUOTE_NOT_ACTIVE':
      return 'اعتبار قیمت پایان یافته است؛ قیمت تازه دریافت کنید.'
    case 'ORDER_CONCURRENCY_CONFLICT':
      return 'نتیجه ثبت سفارش نامشخص است؛ با همان درخواست دوباره تلاش کنید.'
    case 'CART_EMPTY':
      return 'برای دریافت قیمت، ابتدا محصولی به سبد اضافه کنید.'
    case 'COMMERCE_UNAVAILABLE':
      return 'سبد خرید موقتاً در دسترس نیست؛ دوباره تلاش کنید.'
    case 'CITY_DISCOVERY_UNAVAILABLE':
    case 'SERVICEABILITY_UNAVAILABLE':
    case 'CATALOG_UNAVAILABLE':
    case 'SERVICE_UNAVAILABLE':
      return 'سرویس موقتاً در دسترس نیست؛ دوباره تلاش کنید.'
    case 'INVALID_API_RESPONSE':
      return 'پاسخ سرویس معتبر نبود؛ لطفاً دوباره تلاش کنید.'
    default:
      return 'درخواست انجام نشد؛ اطلاعات را بررسی و دوباره تلاش کنید.'
  }
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.primary[50] },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    gap: 20,
    paddingHorizontal: 20,
    paddingVertical: 32,
  },
  brandLockup: { alignItems: 'flex-end', gap: 2 },
  brand: {
    color: colors.primary[800],
    fontSize: 22,
    fontWeight: '800',
    textAlign: 'right',
  },
  brandCaption: { color: colors.neutral[600], fontSize: 13, textAlign: 'right' },
  card: {
    gap: 16,
    padding: 24,
    borderWidth: 1,
    borderColor: colors.primary[100],
    borderRadius: 28,
    backgroundColor: colors.neutral[50],
  },
  catalogPanel: { gap: 16 },
  title: {
    color: colors.neutral[900],
    fontSize: 28,
    fontWeight: '800',
    lineHeight: 40,
    textAlign: 'right',
  },
  subtitle: {
    color: colors.neutral[600],
    fontSize: 16,
    lineHeight: 28,
    textAlign: 'right',
  },
  fieldLabel: { color: colors.neutral[700], fontSize: 14, fontWeight: '700', textAlign: 'right' },
  input: {
    minHeight: 56,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: colors.neutral[300],
    borderRadius: 16,
    backgroundColor: colors.neutral[50],
    color: colors.neutral[900],
    fontSize: 18,
    writingDirection: 'ltr',
  },
  rtlInput: { textAlign: 'right', writingDirection: 'rtl' },
  primaryButton: {
    minHeight: 54,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
    borderRadius: 16,
    backgroundColor: colors.primary[700],
  },
  buttonDisabled: { opacity: 0.55 },
  primaryButtonText: { color: colors.neutral[50], fontSize: 16, fontWeight: '800' },
  secondaryButton: {
    minHeight: 46,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
    borderWidth: 1,
    borderColor: colors.primary[200],
    borderRadius: 14,
  },
  secondaryButtonText: { color: colors.primary[800], fontSize: 15, fontWeight: '700' },
  message: {
    padding: 14,
    borderWidth: 1,
    borderColor: '#FECACA',
    borderRadius: 14,
    backgroundColor: '#FEF2F2',
  },
  messageText: { color: '#991B1B', lineHeight: 24, textAlign: 'right' },
  loadingText: { color: colors.neutral[700], textAlign: 'center' },
  cityList: { flexDirection: 'row-reverse', flexWrap: 'wrap', gap: 8 },
  cityChip: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: colors.neutral[300],
    borderRadius: 999,
    backgroundColor: colors.neutral[50],
  },
  cityChipSelected: {
    borderColor: colors.primary[700],
    backgroundColor: colors.primary[100],
  },
  cityChipText: { color: colors.neutral[700], fontWeight: '700' },
  cityChipTextSelected: { color: colors.primary[900] },
  sessionRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sessionBadge: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: '#DCFCE7',
  },
  sessionBadgeText: { color: '#166534', fontSize: 12, fontWeight: '800' },
  logoutText: { color: colors.primary[800], fontWeight: '700' },
  emptyText: {
    padding: 18,
    borderRadius: 16,
    backgroundColor: colors.neutral[100],
    color: colors.neutral[600],
    lineHeight: 26,
    textAlign: 'right',
  },
  productList: { gap: 12 },
  productCard: {
    gap: 14,
    padding: 18,
    borderWidth: 1,
    borderColor: colors.neutral[200],
    borderRadius: 20,
    backgroundColor: colors.neutral[50],
  },
  productTopRow: { gap: 12 },
  productName: {
    color: colors.neutral[900],
    fontSize: 19,
    fontWeight: '800',
    textAlign: 'right',
  },
  promiseBadge: {
    alignSelf: 'flex-end',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: colors.neutral[100],
  },
  promiseText: { color: colors.neutral[700], fontSize: 12, fontWeight: '700' },
  freshBadge: { backgroundColor: '#ECFCCB' },
  freshText: { color: '#3F6212' },
  price: { color: colors.primary[800], fontSize: 16, fontWeight: '800', textAlign: 'right' },
  cartCard: {
    gap: 14,
    padding: 20,
    borderWidth: 1,
    borderColor: colors.primary[200],
    borderRadius: 22,
    backgroundColor: colors.cream,
  },
  cartTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  cartTitle: { color: colors.neutral[900], fontSize: 20, fontWeight: '800' },
  cartVersion: { color: colors.neutral[500], fontSize: 12 },
  cartItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.primary[100],
  },
  cartItemCopy: { flex: 1, gap: 4, alignItems: 'flex-end' },
  cartItemName: { color: colors.neutral[900], fontWeight: '800', textAlign: 'right' },
  cartItemMeta: { color: colors.neutral[600], fontSize: 13, textAlign: 'right' },
  removeText: { color: colors.error, fontSize: 13, fontWeight: '700' },
  totalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  totalLabel: { color: colors.neutral[700], fontWeight: '800' },
  quoteCard: {
    gap: 8,
    padding: 16,
    borderRadius: 16,
    backgroundColor: colors.neutral[50],
  },
  quoteTitle: { color: colors.success, fontWeight: '800', textAlign: 'right' },
  quoteMeta: { color: colors.neutral[600], textAlign: 'right' },
  quoteTotal: {
    color: colors.primary[800],
    fontSize: 22,
    fontWeight: '900',
    textAlign: 'right',
  },
  quoteNotice: { color: colors.neutral[600], fontSize: 12, lineHeight: 20, textAlign: 'right' },
  addressOption: {
    gap: 4,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.neutral[200],
    borderRadius: 14,
    backgroundColor: colors.neutral[50],
  },
  addressSelected: { borderColor: colors.primary[700], backgroundColor: colors.primary[100] },
  orderConfirmation: {
    gap: 8,
    padding: 16,
    borderWidth: 1,
    borderColor: '#86EFAC',
    borderRadius: 16,
    backgroundColor: '#F0FDF4',
  },
})
