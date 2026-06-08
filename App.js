import React, { useState, useRef, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Image,
  ScrollView, Alert, Dimensions, SafeAreaView, StatusBar, Vibration,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImageManipulator from 'expo-image-manipulator';
import * as MediaLibrary from 'expo-media-library';

const { width: SW, height: SH } = Dimensions.get('window');

const C = {
  bg: '#15140f', panel: '#1e1c15', ink: '#ECE7DA',
  muted: '#928b78', amber: '#F5A623', green: '#7BC96F',
  dark: '#0c0b08', line: 'rgba(236,231,218,0.12)',
};

// Camera view occupies ~58% of screen height
const CAM_H = Math.round(SH * 0.58);

// Guide box: Pokémon card ratio 2.5 : 3.5 = 5 : 7
// Fit within camera view with 20px headroom each side
const MAX_GUIDE_H = CAM_H - 40;
const MAX_GUIDE_W = SW - 56;
const GUIDE_W = MAX_GUIDE_W * (7 / 5) <= MAX_GUIDE_H
  ? MAX_GUIDE_W
  : Math.round(MAX_GUIDE_H * (5 / 7));
const GUIDE_H = Math.round(GUIDE_W * (7 / 5));
const GUIDE_LEFT = Math.round((SW - GUIDE_W) / 2);
const GUIDE_TOP = Math.round((CAM_H - GUIDE_H) / 2);

export default function App() {
  const [camPerm, requestCamPerm] = useCameraPermissions();
  const [mediaPerm, requestMediaPerm] = MediaLibrary.usePermissions();
  const cameraRef = useRef(null);
  // Actual layout of the CameraView in points (updated via onLayout)
  const camLayout = useRef({ width: SW, height: CAM_H });

  const [side, setSide] = useState('front');
  const [frontImg, setFrontImg] = useState(null);
  const [pairs, setPairs] = useState([]);
  const [busy, setBusy] = useState(false);

  // Map the guide box from camera-view coordinates to captured-image pixels.
  // CameraView uses "cover" mode: the image is scaled to fill the view,
  // cropping whichever axis overflows.
  const cropToGuide = useCallback(async (photo) => {
    const { width: iw, height: ih } = photo;
    const { width: cw, height: ch } = camLayout.current;

    const scale = Math.max(cw / iw, ch / ih);
    const ox = (cw - iw * scale) / 2; // negative = image extends past edge
    const oy = (ch - ih * scale) / 2;

    const ix = Math.max(0, Math.round((GUIDE_LEFT - ox) / scale));
    const iy = Math.max(0, Math.round((GUIDE_TOP - oy) / scale));
    const iw2 = Math.min(iw - ix, Math.round(GUIDE_W / scale));
    const ih2 = Math.min(ih - iy, Math.round(GUIDE_H / scale));

    return ImageManipulator.manipulateAsync(
      photo.uri,
      [
        { crop: { originX: ix, originY: iy, width: iw2, height: ih2 } },
        { resize: { width: 1200 } },
      ],
      { compress: 0.92, format: ImageManipulator.SaveFormat.JPEG }
    );
  }, []);

  const handleCapture = useCallback(async () => {
    if (!cameraRef.current || busy) return;
    setBusy(true);
    Vibration.vibrate(40);
    try {
      const raw = await cameraRef.current.takePictureAsync({ quality: 0.92, exif: false });
      const processed = await cropToGuide(raw);

      if (side === 'front') {
        setFrontImg(processed);
        setSide('back');
      } else {
        const saved = frontImg;
        setPairs(prev => [...prev, { id: Date.now(), front: saved, back: processed }]);
        setFrontImg(null);
        setSide('front');
      }
    } catch (e) {
      Alert.alert('Capture failed', e.message);
    } finally {
      setBusy(false);
    }
  }, [busy, side, frontImg, cropToGuide]);

  const saveAll = useCallback(async () => {
    if (!pairs.length) return;
    if (!mediaPerm?.granted) {
      const r = await requestMediaPerm();
      if (!r.granted) {
        Alert.alert('Permission needed', 'Allow photo library access to save your cards.');
        return;
      }
    }
    for (const p of pairs) {
      await MediaLibrary.saveToLibraryAsync(p.front.uri);
      await MediaLibrary.saveToLibraryAsync(p.back.uri);
    }
    Alert.alert('Saved!', `${pairs.length * 2} photos added to your Photos library.`);
  }, [pairs, mediaPerm, requestMediaPerm]);

  const clearAll = useCallback(() => {
    setPairs([]);
    setFrontImg(null);
    setSide('front');
  }, []);

  // ── Permission screen ──────────────────────────────────────────────────────
  if (!camPerm) return <View style={{ flex: 1, backgroundColor: C.bg }} />;

  if (!camPerm.granted) {
    return (
      <View style={[s.root, s.permScreen]}>
        <StatusBar barStyle="light-content" />
        <Text style={s.permTitle}>Camera access needed</Text>
        <Text style={s.permSub}>
          This app needs camera access to photograph Pokémon cards.
        </Text>
        <TouchableOpacity style={s.primaryBtn} onPress={requestCamPerm}>
          <Text style={s.primaryBtnTxt}>Allow camera</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Main screen ────────────────────────────────────────────────────────────
  const isFront = side === 'front';
  const accent = isFront ? C.amber : C.green;

  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" />
      <SafeAreaView style={{ flex: 1 }}>

        {/* Header */}
        <View style={s.header}>
          <Text style={s.headerTitle}>POKÉMON CARD SCANNER</Text>
          <Text style={s.headerSub}>
            {pairs.length} card{pairs.length !== 1 ? 's' : ''} captured
          </Text>
        </View>

        {/* Camera viewport */}
        <View
          style={s.cameraWrap}
          onLayout={e => { camLayout.current = e.nativeEvent.layout; }}
        >
          <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" />

          {/* Guide overlay (pointer-events none so touches pass to camera) */}
          <View pointerEvents="none" style={StyleSheet.absoluteFill}>

            {/* Dim bars around guide box */}
            <View style={[s.dim, { top: 0, height: GUIDE_TOP }]} />
            <View style={[s.dim, { bottom: 0, height: GUIDE_TOP }]} />
            <View style={[s.dim, { top: GUIDE_TOP, height: GUIDE_H, left: 0, right: undefined, width: GUIDE_LEFT }]} />
            <View style={[s.dim, { top: GUIDE_TOP, height: GUIDE_H, right: 0, left: undefined, width: GUIDE_LEFT }]} />

            {/* Guide border */}
            <View style={[s.guide, {
              top: GUIDE_TOP, left: GUIDE_LEFT,
              width: GUIDE_W, height: GUIDE_H,
              borderColor: accent,
            }]}>
              <View style={[s.cTL, { borderColor: accent }]} />
              <View style={[s.cTR, { borderColor: accent }]} />
              <View style={[s.cBL, { borderColor: accent }]} />
              <View style={[s.cBR, { borderColor: accent }]} />
            </View>

            {/* FRONT / BACK badge */}
            <View style={[s.badge, {
              top: GUIDE_TOP - 30,
              left: GUIDE_LEFT,
              width: GUIDE_W,
              borderColor: accent + '55',
            }]}>
              <Text style={[s.badgeTxt, { color: accent }]}>
                {side.toUpperCase()}
              </Text>
            </View>

            {/* Hint below guide */}
            <Text style={[s.hint, { top: GUIDE_TOP + GUIDE_H + 8 }]}>
              {isFront
                ? 'Place card face-up · align to the box'
                : 'Flip card · place face-down · align to box'}
            </Text>
          </View>
        </View>

        {/* Shutter row */}
        <View style={s.shutterRow}>
          {pairs.length > 0 ? (
            <TouchableOpacity style={s.sideBtn} onPress={saveAll}>
              <Text style={s.sideBtnTxt}>Save</Text>
            </TouchableOpacity>
          ) : <View style={s.sideBtn} />}

          <TouchableOpacity
            style={[s.shutterOuter, { borderColor: accent, opacity: busy ? 0.45 : 1 }]}
            onPress={handleCapture}
            disabled={busy}
            activeOpacity={0.75}
          >
            <View style={[s.shutterInner, { backgroundColor: accent }]} />
          </TouchableOpacity>

          {pairs.length > 0 ? (
            <TouchableOpacity style={s.sideBtn} onPress={clearAll}>
              <Text style={[s.sideBtnTxt, { color: C.muted }]}>Clear</Text>
            </TouchableOpacity>
          ) : <View style={s.sideBtn} />}
        </View>

        <Text style={s.shutterLabel}>
          {busy ? 'Processing…' : `Tap to capture ${side}`}
        </Text>

        {/* Tray */}
        {pairs.length > 0 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={s.tray}
            contentContainerStyle={s.trayContent}
          >
            {pairs.map((p, idx) => (
              <View key={p.id} style={s.pairCard}>
                <Text style={s.pairNum}>#{idx + 1}</Text>
                <View style={s.pairThumbs}>
                  <View style={s.thumbCol}>
                    <Image source={{ uri: p.front.uri }} style={s.thumb} />
                    <Text style={s.thumbLbl}>front</Text>
                  </View>
                  <View style={s.thumbCol}>
                    <Image source={{ uri: p.back.uri }} style={s.thumb} />
                    <Text style={s.thumbLbl}>back</Text>
                  </View>
                </View>
                <TouchableOpacity
                  style={s.delBtn}
                  onPress={() => setPairs(prev => prev.filter(x => x.id !== p.id))}
                >
                  <Text style={s.delTxt}>✕</Text>
                </TouchableOpacity>
              </View>
            ))}
          </ScrollView>
        )}

      </SafeAreaView>
    </View>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────
const CS = 20; // corner accent size (points)
const CW = 3;  // corner accent line width

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },

  // Permission screen
  permScreen: { justifyContent: 'center', alignItems: 'center', padding: 36 },
  permTitle: { color: C.ink, fontSize: 22, fontWeight: '700', marginBottom: 12, textAlign: 'center' },
  permSub: { color: C.muted, fontSize: 15, textAlign: 'center', lineHeight: 22, marginBottom: 28 },
  primaryBtn: { backgroundColor: C.amber, paddingHorizontal: 28, paddingVertical: 14, borderRadius: 12 },
  primaryBtnTxt: { color: '#1a1812', fontSize: 16, fontWeight: '700' },

  // Header
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 18, paddingVertical: 10,
  },
  headerTitle: { color: C.ink, fontSize: 14, fontWeight: '800', letterSpacing: 0.8 },
  headerSub: { color: C.muted, fontSize: 12 },

  // Camera
  cameraWrap: { width: SW, height: CAM_H, overflow: 'hidden', backgroundColor: C.dark },

  // Guide overlays
  dim: {
    position: 'absolute', left: 0, right: 0,
    backgroundColor: 'rgba(12,11,8,0.62)',
  },
  guide: { position: 'absolute', borderWidth: 1.5 },

  // Corner accents
  cTL: { position: 'absolute', top: -2, left: -2, width: CS, height: CS, borderTopWidth: CW, borderLeftWidth: CW, borderTopLeftRadius: 5 },
  cTR: { position: 'absolute', top: -2, right: -2, width: CS, height: CS, borderTopWidth: CW, borderRightWidth: CW, borderTopRightRadius: 5 },
  cBL: { position: 'absolute', bottom: -2, left: -2, width: CS, height: CS, borderBottomWidth: CW, borderLeftWidth: CW, borderBottomLeftRadius: 5 },
  cBR: { position: 'absolute', bottom: -2, right: -2, width: CS, height: CS, borderBottomWidth: CW, borderRightWidth: CW, borderBottomRightRadius: 5 },

  // Badge
  badge: {
    position: 'absolute', alignItems: 'center',
    borderWidth: 1, borderRadius: 6,
    backgroundColor: 'rgba(12,11,8,0.75)',
    paddingVertical: 3,
  },
  badgeTxt: { fontSize: 11, fontWeight: '700', letterSpacing: 1.5 },

  // Hint
  hint: {
    position: 'absolute', left: 0, right: 0, textAlign: 'center',
    color: C.ink, fontSize: 12,
    textShadowColor: '#000', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4,
  },

  // Shutter
  shutterRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 32, paddingTop: 14,
  },
  sideBtn: { width: 60, alignItems: 'center' },
  sideBtnTxt: { color: C.ink, fontSize: 14, fontWeight: '600' },
  shutterOuter: {
    width: 70, height: 70, borderRadius: 35, borderWidth: 4,
    alignItems: 'center', justifyContent: 'center',
  },
  shutterInner: { width: 54, height: 54, borderRadius: 27 },
  shutterLabel: { textAlign: 'center', color: C.muted, fontSize: 12, marginTop: 6, marginBottom: 10 },

  // Tray
  tray: { borderTopWidth: 1, borderTopColor: C.line },
  trayContent: { flexDirection: 'row', padding: 12, gap: 10 },

  pairCard: {
    backgroundColor: C.panel, borderRadius: 12, padding: 8,
    borderWidth: 1, borderColor: C.line, position: 'relative',
  },
  pairNum: { color: C.muted, fontSize: 9, textAlign: 'center', marginBottom: 5 },
  pairThumbs: { flexDirection: 'row', gap: 6 },
  thumbCol: { alignItems: 'center' },
  thumb: { width: 48, height: 67, borderRadius: 5, backgroundColor: C.dark },
  thumbLbl: { color: C.muted, fontSize: 9, marginTop: 3 },
  delBtn: {
    position: 'absolute', top: -7, right: -7,
    width: 20, height: 20, borderRadius: 10,
    backgroundColor: C.dark, borderWidth: 1, borderColor: C.line,
    alignItems: 'center', justifyContent: 'center',
  },
  delTxt: { color: C.muted, fontSize: 10 },
});
