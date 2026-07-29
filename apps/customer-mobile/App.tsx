import { useEffect, useMemo, useState } from 'react'
import * as Location from 'expo-location'
import { StatusBar } from 'expo-status-bar'
import {
  ActivityIndicator,
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
  CartSummary,
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
  const [quoteCommandKey, setQuoteCommandKey] = useState<string>()
  const [phone, setPhone] = useState('')
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
          await Promise.all([loadCities(api, active), loadCart(api, active)])
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
    try {
      const challenge = await api.requestOtp(mobileE164)
      setChallengeId(challenge.challengeId)
      setOtp('')
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
        const activeCart = await api.getCart()
        setCities(activeCities)
        setSelectedCityId(activeCities[0]?.id)
        setCart(activeCart)
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
    try {
      setCart(await api.removeCartItem(offeringId, cart.version))
    } catch (error) {
      handleAuthenticatedError(error)
    } finally {
      setBusy(false)
    }
  }

  const createQuote = async () => {
    if (!api || !cart || cart.items.length === 0 || busy) return
    const idempotencyKey =
      quoteCommandKey ??
      `mobile-quote-${Date.now()}-${Math.random().toString(36).slice(2, 12).padEnd(10, '0')}`
    setQuoteCommandKey(idempotencyKey)
    setBusy(true)
    setMessage(undefined)
    try {
      setQuote(await api.createQuote(cart.version, idempotencyKey))
      setQuoteCommandKey(undefined)
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
      setQuoteCommandKey(undefined)
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
      setQuoteCommandKey(undefined)
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
          {cart && (
            <CartCard
              cart={cart}
              quote={quote}
              busy={busy}
              onRemove={(offeringId) => void removeCartItem(offeringId)}
              onQuote={() => void createQuote()}
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

function CartCard({
  cart,
  quote,
  busy,
  onRemove,
  onQuote,
}: {
  cart: CartSummary
  quote: QuoteSummary | null
  busy: boolean
  onRemove: (offeringId: string) => void
  onQuote: () => void
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
        disabled={cart.items.length === 0}
        onPress={onQuote}
      />
      {quote && (
        <View style={styles.quoteCard}>
          <Text style={styles.quoteTitle}>قیمت تا زمان درج‌شده معتبر است</Text>
          <Text style={styles.quoteMeta}>
            انقضا: {new Date(quote.expiresAt).toLocaleTimeString('fa-IR')}
          </Text>
          <Text style={styles.quoteTotal}>{formatRials(quote.total.amount)}</Text>
          <Text style={styles.quoteNotice}>
            این مرحله هنوز سفارش یا پرداخت ایجاد نمی‌کند و ظرفیت را دائمی رزرو نمی‌کند.
          </Text>
        </View>
      )}
    </View>
  )
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

function errorMessage(error: unknown): string {
  if (!(error instanceof CustomerApiError)) {
    return 'ارتباط با سرویس برقرار نشد؛ دوباره تلاش کنید.'
  }

  switch (error.code) {
    case 'OTP_DELIVERY_UNAVAILABLE':
      return 'ارسال پیامک هنوز فعال نشده است؛ کمی بعد دوباره تلاش کنید.'
    case 'OTP_COOLDOWN_ACTIVE':
      return `برای درخواست دوباره ${error.retryAfterSeconds ?? 60} ثانیه صبر کنید.`
    case 'OTP_RATE_LIMITED':
      return 'تعداد درخواست‌ها بیش از حد مجاز است؛ بعداً دوباره تلاش کنید.'
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
      return 'ظرفیت این شعبه برای دریافت قیمت فعلاً تکمیل است.'
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
})
