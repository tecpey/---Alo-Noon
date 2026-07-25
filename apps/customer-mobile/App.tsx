import { StatusBar } from 'expo-status-bar'
import { SafeAreaView, StyleSheet, Text, View } from 'react-native'

import { customerCopy } from './src/copy'

export default function App() {
  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.card}>
        <Text style={styles.brand}>آلو نون</Text>
        <Text style={styles.title}>{customerCopy.title}</Text>
        <Text style={styles.subtitle}>{customerCopy.subtitle}</Text>
      </View>
      <StatusBar style="dark" />
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, justifyContent: 'center', backgroundColor: '#FFF7ED', padding: 24 },
  card: { gap: 16, padding: 28, borderRadius: 24, backgroundColor: '#FFFFFF' },
  brand: { color: '#C2410C', fontSize: 18, fontWeight: '700', textAlign: 'right' },
  title: { color: '#431407', fontSize: 36, fontWeight: '700', textAlign: 'right' },
  subtitle: { color: '#7C2D12', fontSize: 17, lineHeight: 30, textAlign: 'right' },
})
