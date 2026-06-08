import React, { useState, useRef, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Image,
  ScrollView, Alert, Dimensions, SafeAreaView, StatusBar, Vibration,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImageManipulator from 'expo-image-manipulator';
import * as MediaLibrary from 'expo-media-library';
import { WebView } from 'react-native-webview';

const { width: SW, height: SH } = Dimensions.get('window');

const C = {
  bg: '#15140f', panel: '#1e1c15', ink: '#ECE7DA',
  muted: '#928b78', amber: '#F5A623', green: '#7BC96F',
  dark: '#0c0b08', line: 'rgba(236,231,218,0.12)',
};

const CAM_H = Math.round(SH * 0.58);
const MAX_GUIDE_H = CAM_H - 40;
const MAX_GUIDE_W = SW - 56;
const GUIDE_W = MAX_GUIDE_W * (7 / 5) <= MAX_GUIDE_H
  ? MAX_GUIDE_W
  : Math.round(MAX_GUIDE_H * (5 / 7));
const GUIDE_H = Math.round(GUIDE_W * (7 / 5));
const GUIDE_LEFT = Math.round((SW - GUIDE_W) / 2);
const GUIDE_TOP = Math.round((CAM_H - GUIDE_H) / 2);

// Runs in a hidden WebView: scans pixel data and returns the bounding box
// of all non-dark pixels (the card against a black background) as
// normalised {fx, fy, fw, fh} fractions of the image dimensions.
const DETECTION_HTML = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;">
<canvas id="c"></canvas>
<script>
function run(e) {
  var src = typeof e.data === 'string' ? e.data : null;
  if (!src || src.indexOf('data:') !== 0) return;
  var img = new Image();
  img.onload = function() {
    var c = document.getElementById('c');
    var w = img.naturalWidth, h = img.naturalHeight;
    c.width = w; c.height = h;
    var ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    var d = ctx.getImageData(0, 0, w, h).data;
    var minX = w, minY = h, maxX = 0, maxY = 0;
    var T = 35;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var i = (y * w + x) * 4;
        if (d[i] > T || d[i+1] > T || d[i+2] > T) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX > minX + 20 && maxY > minY + 20) {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        fx: minX / w, fy: minY / h,
        fw: (maxX - minX) / w, fh: (maxY - minY) / h,
      }));
    } else {
      window.ReactNativeWebView.postMessage('null');
    }
  };
  img.onerror = function() { window.ReactNativeWebView.postMessage('null'); };
  img.src = src;
}
window.addEventListener('message', run);
document.addEventListener('message', run);
</script>
</body></html>`;

const DETECT_TIMEOUT_MS = 8000;

export default function App() {
  const [camPerm, requestCamPerm] = useCameraPermissions();
  const [mediaPerm, requestMediaPerm] = MediaLibrary.usePermissions();
  const cameraRef = useRef(null);
  const camLayout = useRef({ width: SW, height: CAM_H });

  const webviewRef = useRef(null);
  const webviewReady = useRef(false);
  const detectResolve = useRef(null);
  const detectTimer = useRef(null);

  const [side, setSide] = useState('front');
  const [frontImg, setFrontImg] = useState(null);
  const [pairs, setPairs] = useState([]);
  const [busy, setBusy] = useState(false);

  const handleWebViewLoad = useCallback(() => {
    webviewReady.current = true;
  }, []);

  const handleWebViewMessage = useCallback((event) => {
    if (!detectResolve.current) return;
    clearTimeout(detectTimer.current);
    const resolve = detectResolve.current;
    detectResolve.current = null;
    try { resolve(JSON.parse(event.nativeEvent.data)); }
    catch { resolve(null); }
  }, []);

  // Resize photo to a small thumbnail, send to WebView as base64 data URI,
  // get back the card bounding box as normalised fractions.
  const detectCardBounds = useCallback(async (uri) => {
    if (!webviewReady.current || !webviewRef.current) return null;
    try {
      const thumb = await ImageManipulator.manipulateAsync(
        uri,
        [{ resize: { width: 400 } }],
        { compress: 0.75, format: ImageManipulator.SaveFormat.JPEG, base64: true },
      );
      if (!thumb.base64) return null;
      return await new Promise((resolve) => {
        detectTimer.current = setTimeout(() => {
          detectResolve.current = null;
          resolve(null);
        }, DETECT_TIMEOUT_MS);
        detectResolve.current = resolve;
        webviewRef.current.postMessage(`data:image/jpeg;base64,${thumb.base64}`);
      });
    } catch {
      return null;
    }
  }, []);

  // Fallback: crop to the on-screen guide box.
  const cropToGuide = useCallback(async (photo) => {
    const { width: iw, height: ih } = photo;
    const { width: cw, height: ch } = camLayout.current;
    const scale = Math.max(cw / iw, ch / ih);
    const ox = (cw - iw * scale) / 2;
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
      { compress: 0.92, format: ImageManipulator.SaveFormat.JPEG },
    );
  }, []);

  // Auto-detect card edges; fall back to guide box crop if detection fails.
  const autoCrop = useCallback(async (photo) => {
    const bounds = await detectCardBounds(photo.uri);
    if (!bounds || bounds.fw * bounds.fh < 0.05 || bounds.fw * bounds.fh > 0.97) {
      return cropToGuide(photo);
    }
    const { width: iw, height: ih } = photo;
    const PAD = 0.018; // small black border around the card
    const ox = Math.max(0, Math.round((bounds.fx - PAD) * iw));
    const oy = Math.max(0, Math.round((bounds.fy - PAD) * ih));
    const cw = Math.min(iw - ox, Math.round((bounds.fw + PAD * 2) * iw));
    const ch = Math.min(ih - oy, Math.round((bounds.fh + PAD * 2) * ih));
    return ImageManipulator.manipulateAsync(
      photo.uri,
      [
        { crop: { originX: ox, originY: oy, width: cw, height: ch } },
        { resize: { width: 1200 } },
      ],
      { compress: 0.92, format: ImageManipulator.SaveFormat.JPEG },
    );
  }, [detectCardBounds, cropToGuide]);

  const handleCapture = useCallback(async () => {
    if (!cameraRef.current || busy) return;
    setBusy(true);
    Vibration.vibrate(40);
    try {
      const raw = await cameraRef.current.takePictureAsync({ quality: 0.92, exif: false });
      const processed = await autoCrop(raw);
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
  }, [busy, side, frontImg, autoCrop]);

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

  // ── Permission screen ────────────────────────────────────────────────────
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

  // ── Main screen ──────────────────────────────────────────────────────────
  const isFront = side === 'front';
  const accent = isFront ? C.amber : C.green;

  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" />

      {/* WebView is clipped inside a 0×0 container — invisible but JS runs */}
      <View style={s.detectorClip}>
        <WebView
          ref={webviewRef}
          source={{ html: DETECTION_HTML }}
          onMessage={handleWebViewMessage}
          onLoad={handleWebViewLoad}
          style={s.detectorWebView}
          javaScriptEnabled
          originWhitelist={['*']}
        />
      </View>

      <SafeAreaView style={s.safeArea}>

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

          {/* Guide overlay — pointer-events none so taps reach the camera */}
          <View pointerEvents="none" style={StyleSheet.absoluteFill}>

            {/* Four dim bars surrounding the guide box */}
            <View style={[s.dim, { top: 0,        left: 0, right: 0,        height: GUIDE_TOP }]} />
            <View style={[s.dim, { bottom: 0,      left: 0, right: 0,        height: GUIDE_TOP }]} />
            <View style={[s.dim, { top: GUIDE_TOP, left: 0, width: GUIDE_LEFT, height: GUIDE_H }]} />
            <View style={[s.dim, { top: GUIDE_TOP, right: 0, width: GUIDE_LEFT, height: GUIDE_H }]} />

            {/* Guide border with corner accents */}
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

            {/* FRONT / BACK badge above the guide */}
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

            {/* Hint text below the guide */}
            <Text style={[s.hint, { top: GUIDE_TOP + GUIDE_H + 8 }]}>
              {isFront
                ? 'Place card face-up · align to the box'
                : 'Flip card · place face-down · align to box'}
            </Text>
          </View>
        </View>

        {/* Shutter row */}
        <View style={s.shutterRow}>
          {pairs.length > 0
            ? <TouchableOpacity style={s.sideBtn} onPress={saveAll}>
                <Text style={s.sideBtnTxt}>Save</Text>
              </TouchableOpacity>
            : <View style={s.sideBtn} />}

          <TouchableOpacity
            style={[s.shutterOuter, { borderColor: accent, opacity: busy ? 0.45 : 1 }]}
            onPress={handleCapture}
            disabled={busy}
            activeOpacity={0.75}
          >
            <View style={[s.shutterInner, { backgroundColor: accent }]} />
          </TouchableOpacity>

          {pairs.length > 0
            ? <TouchableOpacity style={s.sideBtn} onPress={clearAll}>
                <Text style={[s.sideBtnTxt, { color: C.muted }]}>Clear</Text>
              </TouchableOpacity>
            : <View style={s.sideBtn} />}
        </View>

        <Text style={s.shutterLabel}>
          {busy ? 'Processing…' : `Tap to capture ${side}`}
        </Text>

        {/* Captured cards tray */}
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

// ── Styles ───────────────────────────────────────────────────────────────────
const CS = 20; // corner accent size
const CW = 3;  // corner accent line width

const s = StyleSheet.create({
  root:     { flex: 1, backgroundColor: C.bg },
  safeArea: { flex: 1 },

  // WebView detector — clipped to 0×0 so it's invisible but still renders/executes JS
  detectorClip:    { position: 'absolute', width: 0, height: 0, overflow: 'hidden' },
  detectorWebView: { width: 300, height: 300 },

  // Permission screen
  permScreen:   { justifyContent: 'center', alignItems: 'center', padding: 36 },
  permTitle:    { color: C.ink, fontSize: 22, fontWeight: '700', marginBottom: 12, textAlign: 'center' },
  permSub:      { color: C.muted, fontSize: 15, textAlign: 'center', lineHeight: 22, marginBottom: 28 },
  primaryBtn:   { backgroundColor: C.amber, paddingHorizontal: 28, paddingVertical: 14, borderRadius: 12 },
  primaryBtnTxt: { color: '#1a1812', fontSize: 16, fontWeight: '700' },

  // Header
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 18, paddingVertical: 10,
  },
  headerTitle: { color: C.ink, fontSize: 14, fontWeight: '800', letterSpacing: 0.8 },
  headerSub:   { color: C.muted, fontSize: 12 },

  // Camera viewport
  cameraWrap: { width: SW, height: CAM_H, overflow: 'hidden', backgroundColor: C.dark },

  // Dim overlay — position and size always provided inline; no defaults here
  dim: { position: 'absolute', backgroundColor: 'rgba(12,11,8,0.62)' },

  // Guide border box
  guide: { position: 'absolute', borderWidth: 1.5 },

  // Corner accents
  cTL: { position: 'absolute', top: -2, left: -2,   width: CS, height: CS, borderTopWidth: CW,    borderLeftWidth: CW,   borderTopLeftRadius: 5 },
  cTR: { position: 'absolute', top: -2, right: -2,  width: CS, height: CS, borderTopWidth: CW,    borderRightWidth: CW,  borderTopRightRadius: 5 },
  cBL: { position: 'absolute', bottom: -2, left: -2, width: CS, height: CS, borderBottomWidth: CW, borderLeftWidth: CW,   borderBottomLeftRadius: 5 },
  cBR: { position: 'absolute', bottom: -2, right: -2, width: CS, height: CS, borderBottomWidth: CW, borderRightWidth: CW,  borderBottomRightRadius: 5 },

  // FRONT/BACK badge
  badge: {
    position: 'absolute', alignItems: 'center',
    borderWidth: 1, borderRadius: 6,
    backgroundColor: 'rgba(12,11,8,0.75)',
    paddingVertical: 3,
  },
  badgeTxt: { fontSize: 11, fontWeight: '700', letterSpacing: 1.5 },

  // Hint text
  hint: {
    position: 'absolute', left: 0, right: 0, textAlign: 'center',
    color: C.ink, fontSize: 12,
    textShadowColor: '#000', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4,
  },

  // Shutter controls
  shutterRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 32, paddingTop: 14,
  },
  sideBtn:      { width: 60, alignItems: 'center' },
  sideBtnTxt:   { color: C.ink, fontSize: 14, fontWeight: '600' },
  shutterOuter: { width: 70, height: 70, borderRadius: 35, borderWidth: 4, alignItems: 'center', justifyContent: 'center' },
  shutterInner: { width: 54, height: 54, borderRadius: 27 },
  shutterLabel: { textAlign: 'center', color: C.muted, fontSize: 12, marginTop: 6, marginBottom: 10 },

  // Captured cards tray
  tray:        { borderTopWidth: 1, borderTopColor: C.line },
  trayContent: { flexDirection: 'row', padding: 12, gap: 10 },

  pairCard: {
    backgroundColor: C.panel, borderRadius: 12, padding: 8,
    borderWidth: 1, borderColor: C.line, position: 'relative',
  },
  pairNum:    { color: C.muted, fontSize: 9, textAlign: 'center', marginBottom: 5 },
  pairThumbs: { flexDirection: 'row', gap: 6 },
  thumbCol:   { alignItems: 'center' },
  thumb:      { width: 48, height: 67, borderRadius: 5, backgroundColor: C.dark },
  thumbLbl:   { color: C.muted, fontSize: 9, marginTop: 3 },
  delBtn: {
    position: 'absolute', top: -7, right: -7,
    width: 20, height: 20, borderRadius: 10,
    backgroundColor: C.dark, borderWidth: 1, borderColor: C.line,
    alignItems: 'center', justifyContent: 'center',
  },
  delTxt: { color: C.muted, fontSize: 10 },
});
