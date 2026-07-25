import { StatusBar } from 'expo-status-bar'
import { SafeAreaView, StyleSheet, Text, View } from 'react-native'

import { courierCopy } from './src/copy'

export default function App() {
  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.card}>
        <Text style={styles.brand}>آلو نون پیک</Text>
        <Text style={styles.title}>{courierCopy.title}</Text>
        <Text style={styles.subtitle}>{courierCopy.subtitle}</Text>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>آماده دریافت سفارش</Text>
        </View>
      </View>
      <StatusBar style="light" />
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, justifyContent: 'center', backgroundColor: '#262626', padding: 24 },
  card: { gap: 16, padding: 28, borderRadius: 24, backgroundColor: '#FFFFFF' },
  brand: { color: '#EA580C', fontSize: 18, fontWeight: '700', textAlign: 'right' },
  title: { color: '#171717', fontSize: 34, fontWeight: '700', textAlign: 'right' },
  subtitle: { color: '#525252', fontSize: 17, lineHeight: 30, textAlign: 'right' },
  badge: { alignSelf: 'flex-end', padding: 12, borderRadius: 999, backgroundColor: '#DCFCE7' },
  badgeText: { color: '#166534', fontWeight: '700' },
})
