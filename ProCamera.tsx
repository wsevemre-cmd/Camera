/**
 * ProCamera.tsx
 * Production-ready Pro Camera for React Native
 *
 * Dependencies:
 *   react-native-vision-camera@^4
 *   react-native-reanimated@^3
 *   @react-native-camera-roll/camera-roll
 *   react-native-safe-area-context
 *   react-native-haptic-feedback (optional, graceful fallback)
 *
 * iOS Info.plist keys required:
 *   NSCameraUsageDescription
 *   NSMicrophoneUsageDescription
 *   NSPhotoLibraryAddUsageDescription
 *
 * Android Manifest permissions:
 *   CAMERA, RECORD_AUDIO, WRITE_EXTERNAL_STORAGE / READ_MEDIA_VIDEO + READ_MEDIA_IMAGES
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Alert,
  Dimensions,
  GestureResponderEvent,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  Camera,
  CameraDevice,
  CameraProps,
  VideoFile,
  useCameraDevice,
  useCameraFormat,
  useCameraPermission,
  useMicrophonePermission,
} from 'react-native-vision-camera';
import Animated, {
  Easing,
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { CameraRoll } from '@react-native-camera-roll/camera-roll';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// ─── Types ──────────────────────────────────────────────────────────────────

type ResolutionKey = '1080p' | '4k';
type FPSValue = 30 | 60;
type CameraPosition = 'back' | 'front';
type CaptureMode = 'photo' | 'video';
type FlashMode = 'on' | 'off';

interface FocusPoint {
  x: number;
  y: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const SCREEN_WIDTH = Dimensions.get('window').width;
const SCREEN_HEIGHT = Dimensions.get('window').height;

const RESOLUTION_MAP: Record<ResolutionKey, { width: number; height: number }> = {
  '1080p': { width: 1920, height: 1080 },
  '4k': { width: 3840, height: 2160 },
};

// ─── Utility: try haptics without hard crash ─────────────────────────────────

function triggerHaptic(type: 'light' | 'medium' | 'heavy' = 'medium'): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const RNHapticFeedback = require('react-native-haptic-feedback').default;
    const map = { light: 'impactLight', medium: 'impactMedium', heavy: 'impactHeavy' } as const;
    RNHapticFeedback.trigger(map[type], { enableVibrateFallback: true });
  } catch {
    // Module not installed — silently skip
  }
}

// ─── Sub-components ──────────────────────────────────────────────────────────

/** Animated square drawn at the tapped focus point */
const FocusSquare: React.FC<{
  point: FocusPoint;
  opacity: Animated.SharedValue<number>;
  scale: Animated.SharedValue<number>;
}> = ({ point, opacity, scale }) => {
  const style = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ scale: scale.value }],
    position: 'absolute',
    left: point.x - 35,
    top: point.y - 35,
    width: 70,
    height: 70,
    borderWidth: 2,
    borderColor: '#FFD60A',
    borderRadius: 4,
  }));
  return <Animated.View style={style} pointerEvents="none" />;
};

/** AE/AF Lock badge */
const AEAFLockBadge: React.FC<{ visible: boolean }> = ({ visible }) => {
  if (!visible) return null;
  return (
    <View style={styles.aeafBadge} pointerEvents="none">
      <Text style={styles.aeafText}>AE/AF LOCK</Text>
    </View>
  );
};

/** Screen-flash overlay for front-camera flash */
const ScreenFlash: React.FC<{ visible: boolean }> = ({ visible }) => {
  if (!visible) return null;
  return <View style={StyleSheet.absoluteFill} pointerEvents="none" testID="screen-flash" />;
};

// ─── Main Component ──────────────────────────────────────────────────────────

export const ProCamera: React.FC = () => {
  const insets = useSafeAreaInsets();

  // ── Permissions ────────────────────────────────────────────────────────────
  const { hasPermission: hasCam, requestPermission: requestCam } = useCameraPermission();
  const { hasPermission: hasMic, requestPermission: requestMic } = useMicrophonePermission();
  const [permissionsGranted, setPermissionsGranted] = useState(false);

  useEffect(() => {
    (async () => {
      const cam = hasCam ? true : await requestCam();
      const mic = hasMic ? true : await requestMic();
      setPermissionsGranted(cam && mic);
    })();
  }, [hasCam, hasMic, requestCam, requestMic]);

  // ── Camera state ───────────────────────────────────────────────────────────
  const [activeCamera, setActiveCamera] = useState<CameraPosition>('back');
  const [mode, setMode] = useState<CaptureMode>('photo');
  const [resolution, setResolution] = useState<ResolutionKey>('1080p');
  const [fps, setFps] = useState<FPSValue>(30);
  const [isMirrored, setIsMirrored] = useState(false);
  const [isFlashOn, setIsFlashOn] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [screenFlashVisible, setScreenFlashVisible] = useState(false);
  const [aeafLocked, setAeafLocked] = useState(false);
  const [focusPoint, setFocusPoint] = useState<FocusPoint | null>(null);
  const [showFocusSquare, setShowFocusSquare] = useState(false);
  const [formatWarning, setFormatWarning] = useState<string | null>(null);

  // ── Camera ref ─────────────────────────────────────────────────────────────
  const cameraRef = useRef<Camera>(null);

  // ── Gesture tracking for double-tap ───────────────────────────────────────
  const lastTapTime = useRef(0);
  const tapTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Reanimated values for focus square ────────────────────────────────────
  const focusOpacity = useSharedValue(0);
  const focusScale = useSharedValue(1.3);

  // ── Device & format selection ─────────────────────────────────────────────
  const device = useCameraDevice(activeCamera) as CameraDevice | undefined;

  const targetRes = RESOLUTION_MAP[resolution];

  /**
   * useCameraFormat: pick the format that best matches our resolution + fps target.
   * We filter to formats that are >= our target resolution and support our fps.
   * VisionCamera v4 useCameraFormat accepts a "filter" object.
   */
  const format = useCameraFormat(device, [
    { videoResolution: { width: targetRes.width, height: targetRes.height } },
    { fps: fps },
  ]);

  // Warn when the selected combination is unavailable
  useEffect(() => {
    if (!format) return;
    const fRes = format.videoWidth;
    const targetW = targetRes.width;
    const supportedFps = format.maxFps;

    const resOk = fRes >= targetW * 0.9; // within 10% tolerance
    const fpsOk = supportedFps >= fps;

    if (!resOk || !fpsOk) {
      const msg = `Device doesn't support ${resolution}@${fps}fps — using best available format.`;
      setFormatWarning(msg);
      console.warn('[ProCamera]', msg, format);
    } else {
      setFormatWarning(null);
    }
  }, [format, resolution, fps, targetRes]);

  // ── Torch / flash props passed to <Camera> ─────────────────────────────────
  /**
   * Torch: only for back camera video recording.
   * Flash: only for back camera photo capture (handled inside takePhoto).
   * Front flash is handled via screen flash (software).
   */
  const torch: CameraProps['torch'] = useMemo(() => {
    if (activeCamera === 'back' && isFlashOn && mode === 'video' && isRecording) {
      return 'on';
    }
    return 'off';
  }, [activeCamera, isFlashOn, mode, isRecording]);

  // ── Focus square animation ─────────────────────────────────────────────────
  const animateFocusSquare = useCallback(
    (point: FocusPoint) => {
      setFocusPoint(point);
      setShowFocusSquare(true);

      // Reset
      cancelAnimation(focusOpacity);
      cancelAnimation(focusScale);

      focusScale.value = 1.3;
      focusOpacity.value = 1;

      focusScale.value = withTiming(1, { duration: 200, easing: Easing.out(Easing.quad) });
      focusOpacity.value = withSequence(
        withTiming(1, { duration: 100 }),
        withDelay(
          1600,
          withTiming(0, { duration: 600 }, (finished) => {
            if (finished) {
              runOnJS(setShowFocusSquare)(false);
            }
          }),
        ),
      );
    },
    [focusOpacity, focusScale],
  );

  // ── Touch handler (single tap + double tap) ───────────────────────────────
  const handleCameraTouch = useCallback(
    async (e: GestureResponderEvent) => {
      const now = Date.now();
      const { locationX, locationY } = e.nativeEvent;
      const point: FocusPoint = { x: locationX, y: locationY };

      const isDoubleTap = now - lastTapTime.current < 300;
      lastTapTime.current = now;

      if (tapTimeout.current) {
        clearTimeout(tapTimeout.current);
        tapTimeout.current = null;
      }

      if (isDoubleTap) {
        // ── Double tap: AE/AF Lock ──────────────────────────────────────────
        triggerHaptic('heavy');
        setAeafLocked(true);
        try {
          // Focus at the point to set the lock position
          await cameraRef.current?.focus({ x: locationX, y: locationY });
        } catch {
          // Some devices don't support programmatic focus lock — ignore
        }
      } else {
        // ── Single tap: Focus + unlock AE/AF if locked ────────────────────
        tapTimeout.current = setTimeout(async () => {
          setAeafLocked(false);
          triggerHaptic('light');
          animateFocusSquare(point);
          try {
            await cameraRef.current?.focus({ x: locationX, y: locationY });
          } catch (err) {
            console.warn('[ProCamera] focus failed:', err);
          }
        }, 150);
      }
    },
    [animateFocusSquare],
  );

  // ── Photo capture ─────────────────────────────────────────────────────────
  const takePhoto = useCallback(async () => {
    if (!cameraRef.current) return;
    triggerHaptic('medium');

    // Front camera software flash
    if (activeCamera === 'front' && isFlashOn) {
      setScreenFlashVisible(true);
      await new Promise<void>((r) => setTimeout(r, 150));
    }

    try {
      const flashMode: 'on' | 'off' =
        activeCamera === 'back' && isFlashOn ? 'on' : 'off';

      const photo = await cameraRef.current.takePhoto({
        flash: flashMode,
        enableShutterSound: true,
      });

      if (activeCamera === 'front' && isFlashOn) {
        setScreenFlashVisible(false);
      }

      // Save to gallery
      let filePath = photo.path;
      if (!filePath.startsWith('file://')) {
        filePath = `file://${filePath}`;
      }

      /**
       * Mirroring note:
       * react-native-vision-camera does not natively flip the saved file.
       * For a production app, you would post-process via a library such as
       * react-native-image-manipulator (flipHorizontal) before saving.
       * Below we demonstrate the hook point; plug in your image processor here.
       */
      if (isMirrored) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const ImageManipulator = require('expo-image-manipulator');
          const result = await ImageManipulator.manipulateAsync(
            filePath,
            [{ flip: ImageManipulator.FlipType.Horizontal }],
            { compress: 1, format: ImageManipulator.SaveFormat.JPEG },
          );
          filePath = result.uri;
        } catch {
          console.warn('[ProCamera] Image manipulator not available; saving un-flipped.');
        }
      }

      await CameraRoll.saveAsset(filePath, { type: 'photo' });
    } catch (err) {
      setScreenFlashVisible(false);
      Alert.alert('Capture Error', String(err));
      console.error('[ProCamera] takePhoto error:', err);
    }
  }, [activeCamera, isFlashOn, isMirrored]);

  // ── Video recording ───────────────────────────────────────────────────────
  const startRecording = useCallback(() => {
    if (!cameraRef.current || isRecording) return;
    triggerHaptic('medium');
    setIsRecording(true);

    cameraRef.current.startRecording({
      onRecordingFinished: async (video: VideoFile) => {
        setIsRecording(false);

        let filePath = video.path;
        if (!filePath.startsWith('file://')) {
          filePath = `file://${filePath}`;
        }

        /**
         * Video mirroring post-processing hook:
         * For a full implementation, pass the video through FFmpeg
         * (e.g., react-native-ffmpeg) with the hflip filter before saving.
         * Example: `ffmpeg -i input.mp4 -vf hflip output.mp4`
         */
        if (isMirrored) {
          console.warn(
            '[ProCamera] Video mirror post-processing: plug in FFmpeg hflip here.',
          );
        }

        try {
          await CameraRoll.saveAsset(filePath, { type: 'video' });
        } catch (err) {
          Alert.alert('Save Error', String(err));
          console.error('[ProCamera] saveAsset error:', err);
        }
      },
      onRecordingError: (err) => {
        setIsRecording(false);
        Alert.alert('Recording Error', err.message);
        console.error('[ProCamera] recording error:', err);
      },
      fileType: 'mp4',
      videoBitRate: resolution === '4k' ? 'extra-high' : 'high',
    });
  }, [cameraRef, isRecording, isMirrored, resolution]);

  const stopRecording = useCallback(async () => {
    if (!cameraRef.current || !isRecording) return;
    triggerHaptic('light');
    await cameraRef.current.stopRecording();
  }, [isRecording]);

  // ── Shutter handler (photo tap / video tap-to-start / tap-to-stop) ────────
  const handleShutter = useCallback(() => {
    if (mode === 'photo') {
      takePhoto();
    } else {
      if (isRecording) {
        stopRecording();
      } else {
        startRecording();
      }
    }
  }, [mode, isRecording, takePhoto, startRecording, stopRecording]);

  // ── Flip camera ────────────────────────────────────────────────────────────
  const flipCamera = useCallback((e: GestureResponderEvent) => {
    e.stopPropagation();
    triggerHaptic('light');
    setActiveCamera((prev) => (prev === 'back' ? 'front' : 'back'));
    setAeafLocked(false);
  }, []);

  // ── Top-bar toggle helpers ─────────────────────────────────────────────────
  const stopProp = useCallback(
    (fn: () => void) => (e: GestureResponderEvent) => {
      e.stopPropagation();
      fn();
    },
    [],
  );

  const toggleFlash = stopProp(() => {
    triggerHaptic('light');
    setIsFlashOn((v) => !v);
  });

  const cycleResolution = stopProp(() => {
    triggerHaptic('light');
    setResolution((r) => (r === '1080p' ? '4k' : '1080p'));
  });

  const cycleFps = stopProp(() => {
    triggerHaptic('light');
    setFps((f) => (f === 30 ? 60 : 30));
  });

  const toggleMirror = stopProp(() => {
    triggerHaptic('light');
    setIsMirrored((v) => !v);
  });

  // ── Permission gate ────────────────────────────────────────────────────────
  if (!permissionsGranted) {
    return (
      <View style={styles.permissionContainer}>
        <Text style={styles.permissionText}>
          Camera & Microphone access is required.
        </Text>
      </View>
    );
  }

  if (!device) {
    return (
      <View style={styles.permissionContainer}>
        <Text style={styles.permissionText}>No camera device found.</Text>
      </View>
    );
  }

  // ── Mirror transform ───────────────────────────────────────────────────────
  const mirrorTransform = isMirrored ? [{ scaleX: -1 }] : [];

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <View style={styles.root}>
      {/* ── Camera Preview ─────────────────────────────────────────────── */}
      <Camera
        ref={cameraRef}
        style={[StyleSheet.absoluteFill, { transform: mirrorTransform }]}
        device={device}
        format={format}
        isActive={true}
        photo={mode === 'photo'}
        video={mode === 'video'}
        audio={mode === 'video'}
        torch={torch}
        enableZoomGesture={true}
        videoStabilizationMode="auto"
        exposure={0}
      />

      {/* ── Touch Overlay (focus gestures) ─────────────────────────────── */}
      <View
        style={styles.touchOverlay}
        onTouchEnd={handleCameraTouch}
        collapsable={false}
      />

      {/* ── Focus Square ───────────────────────────────────────────────── */}
      {showFocusSquare && focusPoint && (
        <FocusSquare
          point={focusPoint}
          opacity={focusOpacity}
          scale={focusScale}
        />
      )}

      {/* ── AE/AF Lock Badge ───────────────────────────────────────────── */}
      <AEAFLockBadge visible={aeafLocked} />

      {/* ── Screen Flash (front camera) ─────────────────────────────────── */}
      {screenFlashVisible && (
        <View style={styles.screenFlash} pointerEvents="none" />
      )}

      {/* ── Format Warning ─────────────────────────────────────────────── */}
      {formatWarning && (
        <View style={styles.warningBanner} pointerEvents="none">
          <Text style={styles.warningText}>{formatWarning}</Text>
        </View>
      )}

      {/* ═══════════════════════════════════════════════════════════════
          TOP BAR
      ═══════════════════════════════════════════════════════════════ */}
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        {/* Flash */}
        <TopBarButton
          label={isFlashOn ? '⚡' : '⚡̷'}
          sublabel={isFlashOn ? 'ON' : 'OFF'}
          active={isFlashOn}
          onPress={toggleFlash}
        />

        {/* Resolution */}
        <TopBarButton
          label={resolution === '4k' ? '4K' : 'HD'}
          sublabel="RES"
          active={resolution === '4k'}
          onPress={cycleResolution}
        />

        {/* FPS */}
        <TopBarButton
          label={`${fps}`}
          sublabel="FPS"
          active={fps === 60}
          onPress={cycleFps}
        />

        {/* Mirror */}
        <TopBarButton
          label="⇌"
          sublabel={isMirrored ? 'MIRR' : 'NORM'}
          active={isMirrored}
          onPress={toggleMirror}
        />
      </View>

      {/* ═══════════════════════════════════════════════════════════════
          BOTTOM BAR
      ═══════════════════════════════════════════════════════════════ */}
      <View style={[styles.bottomBar, { paddingBottom: insets.bottom + 12 }]}>
        {/* Mode toggle (Photo / Video) */}
        <View style={styles.modeToggle}>
          <TouchableOpacity
            style={[styles.modeBtn, mode === 'photo' && styles.modeBtnActive]}
            onPress={stopProp(() => { if (!isRecording) setMode('photo'); })}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          >
            <Text style={[styles.modeBtnText, mode === 'photo' && styles.modeBtnTextActive]}>
              PHOTO
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.modeBtn, mode === 'video' && styles.modeBtnActive]}
            onPress={stopProp(() => { if (!isRecording) setMode('video'); })}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          >
            <Text style={[styles.modeBtnText, mode === 'video' && styles.modeBtnTextActive]}>
              VIDEO
            </Text>
          </TouchableOpacity>
        </View>

        {/* Bottom row: flip | shutter | (empty) */}
        <View style={styles.bottomRow}>
          {/* Flip camera */}
          <TouchableOpacity
            style={styles.flipButton}
            onPress={flipCamera}
            hitSlop={{ top: 16, bottom: 16, left: 16, right: 16 }}
          >
            <Text style={styles.flipIcon}>⟳</Text>
          </TouchableOpacity>

          {/* Shutter */}
          <Pressable
            style={({ pressed }) => [
              styles.shutterOuter,
              mode === 'video' && styles.shutterOuterVideo,
              pressed && styles.shutterPressed,
            ]}
            onPress={(e) => { e.stopPropagation(); handleShutter(); }}
            accessibilityLabel={
              mode === 'photo' ? 'Take Photo' :
              isRecording ? 'Stop Recording' : 'Start Recording'
            }
          >
            <View
              style={[
                styles.shutterInner,
                mode === 'video' && !isRecording && styles.shutterInnerVideo,
                isRecording && styles.shutterInnerRecording,
              ]}
            />
          </Pressable>

          {/* Placeholder to balance layout */}
          <View style={styles.flipButton} />
        </View>

        {/* Recording indicator */}
        {isRecording && (
          <View style={styles.recIndicator} pointerEvents="none">
            <View style={styles.recDot} />
            <Text style={styles.recText}>REC</Text>
          </View>
        )}
      </View>
    </View>
  );
};

// ─── TopBarButton ─────────────────────────────────────────────────────────────

const TopBarButton: React.FC<{
  label: string;
  sublabel: string;
  active?: boolean;
  onPress: (e: GestureResponderEvent) => void;
}> = ({ label, sublabel, active = false, onPress }) => (
  <TouchableOpacity
    style={[styles.topBarBtn, active && styles.topBarBtnActive]}
    onPress={onPress}
    hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
  >
    <Text style={[styles.topBarBtnIcon, active && styles.topBarBtnIconActive]}>
      {label}
    </Text>
    <Text style={[styles.topBarBtnLabel, active && styles.topBarBtnLabelActive]}>
      {sublabel}
    </Text>
  </TouchableOpacity>
);

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#000',
  },
  permissionContainer: {
    flex: 1,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  permissionText: {
    color: '#fff',
    fontSize: 16,
    textAlign: 'center',
    fontFamily: Platform.OS === 'ios' ? 'Helvetica Neue' : 'sans-serif',
  },

  // ── Touch overlay
  touchOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'transparent',
  },

  // ── Screen flash
  screenFlash: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#FFFFFF',
    zIndex: 9999,
  },

  // ── AE/AF badge
  aeafBadge: {
    position: 'absolute',
    top: '42%',
    alignSelf: 'center',
    backgroundColor: 'rgba(255,214,10,0.18)',
    borderColor: '#FFD60A',
    borderWidth: 1.5,
    borderRadius: 6,
    paddingHorizontal: 14,
    paddingVertical: 5,
  },
  aeafText: {
    color: '#FFD60A',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 2,
    fontFamily: Platform.OS === 'ios' ? 'Helvetica Neue' : 'sans-serif-medium',
  },

  // ── Format warning
  warningBanner: {
    position: 'absolute',
    top: '50%',
    left: 24,
    right: 24,
    backgroundColor: 'rgba(255,80,0,0.75)',
    borderRadius: 8,
    padding: 10,
    alignItems: 'center',
  },
  warningText: {
    color: '#fff',
    fontSize: 12,
    textAlign: 'center',
  },

  // ── Top bar
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'space-evenly',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingBottom: 12,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  topBarBtn: {
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.08)',
    minWidth: 58,
  },
  topBarBtnActive: {
    backgroundColor: 'rgba(255,214,10,0.22)',
  },
  topBarBtnIcon: {
    color: '#ccc',
    fontSize: 18,
    lineHeight: 22,
  },
  topBarBtnIconActive: {
    color: '#FFD60A',
  },
  topBarBtnLabel: {
    color: '#888',
    fontSize: 9,
    letterSpacing: 1.2,
    marginTop: 2,
    fontFamily: Platform.OS === 'ios' ? 'Helvetica Neue' : 'sans-serif-medium',
  },
  topBarBtnLabelActive: {
    color: '#FFD60A',
  },

  // ── Bottom bar
  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(0,0,0,0.60)',
    paddingTop: 14,
    paddingHorizontal: 24,
    alignItems: 'center',
  },
  modeToggle: {
    flexDirection: 'row',
    marginBottom: 18,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 20,
    padding: 3,
  },
  modeBtn: {
    paddingHorizontal: 22,
    paddingVertical: 7,
    borderRadius: 18,
  },
  modeBtnActive: {
    backgroundColor: '#fff',
  },
  modeBtnText: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.5,
    fontFamily: Platform.OS === 'ios' ? 'Helvetica Neue' : 'sans-serif-medium',
  },
  modeBtnTextActive: {
    color: '#000',
  },

  // ── Bottom row
  bottomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    marginBottom: 4,
  },
  flipButton: {
    width: 52,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
  },
  flipIcon: {
    color: '#fff',
    fontSize: 30,
  },

  // ── Shutter
  shutterOuter: {
    width: 78,
    height: 78,
    borderRadius: 39,
    borderWidth: 4,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  shutterOuterVideo: {
    borderColor: '#FF3B30',
  },
  shutterPressed: {
    opacity: 0.75,
    transform: [{ scale: 0.96 }],
  },
  shutterInner: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#fff',
  },
  shutterInnerVideo: {
    backgroundColor: '#FF3B30',
  },
  shutterInnerRecording: {
    width: 32,
    height: 32,
    borderRadius: 6,
    backgroundColor: '#FF3B30',
  },

  // ── Rec indicator
  recIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
  },
  recDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#FF3B30',
    marginRight: 6,
  },
  recText: {
    color: '#FF3B30',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 2,
    fontFamily: Platform.OS === 'ios' ? 'Helvetica Neue' : 'sans-serif-medium',
  },
});

export default ProCamera;
