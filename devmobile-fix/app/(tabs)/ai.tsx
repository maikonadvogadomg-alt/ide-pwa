import { Feather } from "@expo/vector-icons";
import React, { useState } from "react";
import { Platform, StyleSheet, TouchableOpacity } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import AIChat from "@/components/AIChat";
import VoiceAssistant from "@/components/VoiceAssistant";
import { useColors } from "@/hooks/useColors";

export default function AIScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const topPadding = Platform.OS === "web" ? 14 : insets.top;
  const tabBottom = Platform.OS === "web" ? 70 : Math.max(insets.bottom, 16) + 70;
  const [voiceOpen, setVoiceOpen] = useState(false);

  const voiceBtn = (
    <TouchableOpacity
      onPress={() => setVoiceOpen(true)}
      style={[styles.voiceBtn, { backgroundColor: "#6366f1" }]}
      accessibilityLabel="Conversa por voz"
    >
      <Feather name="radio" size={14} color="#fff" />
    </TouchableOpacity>
  );

  return (
    <>
      <AIChat
        headerPaddingTop={topPadding}
        extraHeaderRight={voiceBtn}
        paddingBottom={tabBottom}
      />
      <VoiceAssistant visible={voiceOpen} onClose={() => setVoiceOpen(false)} />
    </>
  );
}

const styles = StyleSheet.create({
  voiceBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
  },
});
