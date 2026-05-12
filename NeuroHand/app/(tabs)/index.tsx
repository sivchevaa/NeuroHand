import { StyleSheet, View, Text } from 'react-native';
import { RNMediapipe } from '@thinksys/react-native-mediapipe';

export default function HomeScreen() {
  return (
    <View style={styles.container}>
      <RNMediapipe
        width={400}
        height={700}
        onLandmark={(data: any) => {
          console.log('Hand landmarks detected:', data);
        }}
      />
      <View style={styles.overlay}>
        <Text style={styles.status}>Show your hand to the camera</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  overlay: {
    position: 'absolute',
    bottom: 40,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  status: {
    color: 'white',
    fontSize: 16,
    backgroundColor: 'rgba(0,0,0,0.5)',
    padding: 8,
    borderRadius: 8,
  },
});