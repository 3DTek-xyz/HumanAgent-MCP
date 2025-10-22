import * as path from 'path';

// Use dynamic import to avoid issues with the module
let wavPlayer: any;

export class AudioNotification {
  private static isInitialized = false;
  
  static async initialize() {
    if (!this.isInitialized) {
      try {
        wavPlayer = require('node-wav-player');
        this.isInitialized = true;
        console.log('AudioNotification: Initialized successfully');
      } catch (error) {
        console.error('AudioNotification: Failed to initialize:', error);
      }
    }
  }
  
  static async playNotificationBeep() {
    await this.initialize();
    
    if (!wavPlayer) {
      console.log('AudioNotification: node-wav-player not available');
      return;
    }
    
    try {
      // Use a simple base64 encoded beep sound or generate one programmatically
      await this.generateAndPlayBeep();
    } catch (error) {
      console.error('AudioNotification: Error playing sound:', error);
    }
  }
  
  private static async generateAndPlayBeep() {
    // For now, we'll create a simple beep using system bell if available
    // or we can embed a small sound file
    try {
      // Try to create a simple WAV file programmatically
      const tempSoundPath = await this.createTempBeepFile();
      
      await wavPlayer.play({
        path: tempSoundPath,
        sync: false
      });
      
      console.log('AudioNotification: Beep played successfully');
    } catch (error) {
      console.error('AudioNotification: Failed to play beep:', error);
    }
  }
  
  private static async createTempBeepFile(): Promise<string> {
    // Create a simple WAV beep file programmatically
    const fs = require('fs');
    const os = require('os');
    
    // Simple WAV file header + short sine wave beep
    const sampleRate = 8000;
    const duration = 0.2; // 200ms
    const frequency = 800; // 800Hz beep
    const samples = Math.floor(sampleRate * duration);
    
    // Create WAV buffer
    const buffer = Buffer.alloc(44 + samples * 2);
    
    // WAV header
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + samples * 2, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20); // PCM
    buffer.writeUInt16LE(1, 22); // Mono
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * 2, 28);
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(samples * 2, 40);
    
    // Generate sine wave
    for (let i = 0; i < samples; i++) {
      const sample = Math.sin(2 * Math.PI * frequency * i / sampleRate) * 32767 * 0.3;
      buffer.writeInt16LE(Math.floor(sample), 44 + i * 2);
    }
    
    const tempPath = path.join(os.tmpdir(), 'vscode-beep.wav');
    fs.writeFileSync(tempPath, buffer);
    
    return tempPath;
  }
}