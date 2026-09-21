var App = {
    URL: (function() {
        if (typeof window === 'undefined' || !window.location) {
            return 'http://localhost:7777';
        }

        if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
            return window.location.origin;
        }

        return 'http://localhost:7777';
    })(),
    channelName: 'motion-detection-images',
    channel: null,
    useStorageFallback: false,
    motionDebounceMs: 900,
    motionRatio: 0.01,
    mode: 'all',
    faceRecognition: {
        storageKey: 'motion-detection-known-faces',
        apiUrl: (function() {
            if (typeof window === 'undefined' || !window.location) {
                return 'http://localhost:7777/api/human-data';
            }

            if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
                return window.location.origin + '/api/human-data';
            }

            return 'http://localhost:7777/api/human-data';
        })(),
        modelsUrl: 'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@0.22.2/weights/',
        modelsReady: false,
        modelsLoading: false,
        matcher: null,
        registeredFaces: [],
        pendingCheck: false,
        lastFaceState: null,
        statusEl: null,
        enabled: true
    },

    getMode: function() {
        if (typeof URLSearchParams === 'undefined') {
            return 'all';
        }

        var params = new URLSearchParams(window.location.search);
        var mode = params.get('mode');

        if (mode === 'motion' || mode === 'face') {
            return mode;
        }

        return 'all';
    },

    setMode: function(mode) {
        this.mode = mode || 'all';
        this.faceRecognition.enabled = this.mode !== 'motion';
    },

    init: function(selector) {
        var container = document.querySelector(selector);
        var imageDump = document.querySelector('.imageDump');

        if (!container || !imageDump) {
            console.warn('MotionDetection: missing container or imageDump element.');
            return;
        }

        var self = this;
        var video = document.createElement('video');
        var canvas = document.createElement('canvas');
        var ctx = canvas.getContext('2d', { willReadFrequently: true });
        var status = document.getElementById('status');
        var faceStatus = document.getElementById('face-status');
        var faceNameInput = document.getElementById('face-name');
        var faceAgeInput = document.getElementById('face-age');
        var faceUpload = document.getElementById('face-upload');
        var registerButton = document.getElementById('register-face');
        var knownFacesList = document.getElementById('known-faces');
        var recognizedDetails = document.getElementById('recognized-details');
        var recognizedName = document.getElementById('recognized-name');
        var recognizedAge = document.getElementById('recognized-age');
        var faceControls = document.querySelector('.face-controls');
        var profileManager = document.getElementById('profile-manager');
        var profileManagerList = document.getElementById('profile-manager-list');
        var previousFrame = null;
        var lastMotionAt = 0;
        var lastFaceCheckAt = 0;
        var captureStarted = false;
        var motionResetTimer = null;
        var motionVisible = false;

        self.setMode(self.getMode());
        this.faceRecognition.statusEl = faceStatus;

        if (faceControls) {
            faceControls.style.display = self.faceRecognition.enabled ? '' : 'none';
        }

        if (faceStatus) {
            faceStatus.style.display = self.faceRecognition.enabled ? '' : 'none';
        }

        if (recognizedDetails) {
            recognizedDetails.style.display = self.faceRecognition.enabled ? '' : 'none';
        }

        if (profileManager) {
            profileManager.style.display = self.faceRecognition.enabled ? '' : 'none';
        }

        if (profileManagerList) {
            profileManagerList.addEventListener('click', function(event) {
                var deleteButton = event.target && event.target.closest ? event.target.closest('[data-delete-face]') : null;

                if (!deleteButton) {
                    return;
                }

                var name = deleteButton.getAttribute('data-delete-face');

                if (name) {
                    self.deleteSavedFace(name);
                }
            });
        }

        var showStatus = function(message, type) {
            if (!status) {
                return;
            }

            status.textContent = message;
            status.className = 'status' + (type ? ' ' + type : '');

            if (type === 'motion') {
                motionVisible = true;

                if (motionResetTimer) {
                    clearTimeout(motionResetTimer);
                }

                motionResetTimer = setTimeout(function() {
                    motionVisible = false;
                    status.className = 'status success';
                    status.textContent = 'Camera active. Watching for motion.';
                    motionResetTimer = null;
                }, 2000);
            }
        };

        var showIdleStatus = function() {
            if (!status || motionVisible) {
                return;
            }

            status.textContent = 'Camera active. Watching for motion.';
            status.className = 'status success';
        };

        var updateCanvasSize = function() {
            var width = video.videoWidth || 350;
            var height = video.videoHeight || 350;

            if (!width || !height) {
                width = 350;
                height = 350;
            }

            canvas.width = width;
            canvas.height = height;
        };

        var runFrameAnalysis = function() {
            if (!video || video.readyState < 2) {
                return;
            }

            updateCanvasSize();
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

            var currentFrame = ctx.getImageData(0, 0, canvas.width, canvas.height);
            var changedPixels = previousFrame ? self.utils.countChangedPixels(previousFrame, currentFrame, 25) : 0;
            var motionThreshold = self.utils.motionThreshold(canvas.width, canvas.height, self.motionRatio);
            var hasMotion = changedPixels >= motionThreshold;
            var now = Date.now();

            if (self.mode !== 'face') {
                if (hasMotion && (now - lastMotionAt) >= self.motionDebounceMs) {
                    lastMotionAt = now;
                    self.publishImage(canvas.toDataURL('image/jpeg', 0.85));
                    showStatus('Motion detected!', 'motion');
                } else {
                    showIdleStatus();
                }
            }

            if (self.faceRecognition.enabled && self.faceRecognition.modelsReady && !self.faceRecognition.pendingCheck && (self.mode === 'face' || hasMotion || (now - lastFaceCheckAt) >= 300)) {
                lastFaceCheckAt = now;
                self.faceRecognition.pendingCheck = true;

                self.recognizeFrame(canvas).then(function(result) {
                    if (result && result.message) {
                        self.setFaceStatus(result.message, result.type);
                    }
                }).catch(function(err) {
                    console.warn('MotionDetection: face recognition failed.', err);
                    self.setFaceStatus('Face recognition is temporarily unavailable.', 'error');
                }).finally(function() {
                    self.faceRecognition.pendingCheck = false;
                });
            }

            previousFrame = currentFrame;
        };

        var startMotionLoop = function() {
            if (captureStarted) {
                return;
            }

            captureStarted = true;

            setInterval(function() {
                runFrameAnalysis();
            }, 100);

            if (self.mode !== 'face') {
                showIdleStatus();
            }

            if (self.faceRecognition.enabled) {
                self.setFaceStatus('Face recognition is ready for known faces.', 'success');
            }
        };

        var startCapture = function(stream) {
            video.autoplay = true;
            video.muted = true;
            video.playsInline = true;
            video.style.display = 'none';

            if (typeof video.srcObject !== 'undefined') {
                video.srcObject = stream;
            } else if (window.URL && window.URL.createObjectURL) {
                video.src = window.URL.createObjectURL(stream);
            } else if (window.webkitURL && window.webkitURL.createObjectURL) {
                video.src = window.webkitURL.createObjectURL(stream);
            } else {
                console.warn('MotionDetection: no supported video stream URL API.');
                failCapture(new Error('No supported video stream URL API.'));
                return;
            }

            container.innerHTML = '';
            container.appendChild(canvas);

            video.onloadedmetadata = function() {
                updateCanvasSize();
                video.play().catch(function(err) {
                    console.warn('MotionDetection: video.play() failed.', err);
                    showStatus('Camera active, but video playback could not start.', 'error');
                });
                startMotionLoop();
            };

            video.onplay = function() {
                updateCanvasSize();
                startMotionLoop();
            };

            if (self.mode === 'face') {
                showStatus('Camera active. Face recognition enabled.', 'success');
            }
        };

        var failCapture = function(err) {
            var message = 'Camera access is blocked. Allow camera permission for localhost and refresh the page.';

            if (err && err.name === 'NotAllowedError') {
                message = 'Camera permission was denied. Allow camera access for localhost and refresh the page.';
            } else if (err && err.name === 'NotFoundError') {
                message = 'No camera was found. Connect a webcam and refresh the page.';
            } else if (err && err.name === 'NotReadableError') {
                message = 'The camera is busy or unavailable. Close other apps using it and refresh the page.';
            } else if (err && err.message) {
                message = err.message;
            }

            showStatus(message, 'error');
            console.warn('MotionDetection: camera capture failed.', err);
        };

        if (self.faceRecognition.enabled) {
            this.loadSavedFaces();
            this.updateKnownFacesList();

            if (registerButton) {
                registerButton.addEventListener('click', function() {
                    var name = faceNameInput && faceNameInput.value ? faceNameInput.value.trim() : '';
                    var file = faceUpload && faceUpload.files && faceUpload.files[0];

                    if (!name) {
                        self.setFaceStatus('Enter a face name before registering.', 'error');
                        return;
                    }

                    if (!file) {
                        self.setFaceStatus('Choose a photo to register a face.', 'error');
                        return;
                    }

                    self.registerKnownFace(name, file);
                });
            }

            this.loadFaceModels().catch(function(err) {
                console.warn('MotionDetection: failed to load face recognition models.', err);
                self.setFaceStatus('Face recognition models could not be loaded.', 'error');
            });
        }

        showStatus('Checking camera access...');

        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
            navigator.mediaDevices.getUserMedia({ video: true }).then(startCapture).catch(failCapture);
        } else if (navigator.getUserMedia) {
            navigator.getUserMedia({ video: true }, startCapture, failCapture);
        } else if (navigator.webkitGetUserMedia) {
            navigator.webkitGetUserMedia({ video: true }, startCapture, failCapture);
        } else {
            failCapture(new Error('getUserMedia is not supported in this browser.'));
        }
    },

    loadFaceModels: function() {
        var self = this;

        if (typeof faceapi === 'undefined') {
            return Promise.reject(new Error('face-api.js is not available.'));
        }

        if (this.faceRecognition.modelsReady) {
            return Promise.resolve(true);
        }

        if (this.faceRecognition.modelsLoading) {
            return Promise.resolve(true);
        }

        this.faceRecognition.modelsLoading = true;
        this.setFaceStatus('Loading face recognition models...', 'loading');

        return Promise.all([
            faceapi.nets.tinyFaceDetector.loadFromUri(this.faceRecognition.modelsUrl),
            faceapi.nets.faceLandmark68Net.loadFromUri(this.faceRecognition.modelsUrl),
            faceapi.nets.faceRecognitionNet.loadFromUri(this.faceRecognition.modelsUrl)
        ]).then(function() {
            self.faceRecognition.modelsReady = true;
            self.faceRecognition.modelsLoading = false;
            self.rebuildMatcher();
            self.setFaceStatus('Face recognition is ready.', 'success');
            return true;
        }).catch(function(err) {
            self.faceRecognition.modelsLoading = false;
            throw err;
        });
    },

    normalizeSavedFaces: function(savedFaces) {
        if (!Array.isArray(savedFaces)) {
            return [];
        }

        return savedFaces.map(function(face) {
            if (!face || !face.name || !Array.isArray(face.descriptor)) {
                return null;
            }

            return {
                name: face.name,
                age: face.age || '',
                threatLevel: face.threatLevel || '',
                nationality: face.nationality || '',
                crimeInvolvement: face.crimeInvolvement || '',
                descriptor: Array.from(new Float32Array(face.descriptor))
            };
        }).filter(Boolean);
    },

    loadStoredFaces: function() {
        if (typeof localStorage === 'undefined') {
            return [];
        }

        try {
            return this.normalizeSavedFaces(JSON.parse(localStorage.getItem(this.faceRecognition.storageKey) || '[]'));
        } catch (err) {
            console.warn('MotionDetection: failed to parse stored face profiles.', err);
            return [];
        }
    },

    persistStoredFaces: function(savedFaces) {
        if (typeof localStorage === 'undefined') {
            return;
        }

        localStorage.setItem(this.faceRecognition.storageKey, JSON.stringify(this.normalizeSavedFaces(savedFaces)));
    },

    applySavedFaces: function(savedFaces) {
        this.faceRecognition.registeredFaces = this.normalizeSavedFaces(savedFaces);

        this.rebuildMatcher();
        this.updateKnownFacesList();
        this.renderProfileManager();
        return this.faceRecognition.registeredFaces;
    },

    loadSavedFaces: function() {
        var self = this;
        var savedFaces = self.loadStoredFaces();

        if (savedFaces.length) {
            self.setFaceStatus('Loaded saved profiles from browser cache.', 'success');
        } else {
            self.setFaceStatus('No saved profiles yet. Register a face to start recognition.', 'warning');
        }

        return Promise.resolve(self.applySavedFaces(savedFaces));
    },

    saveSavedFaces: function(profile) {
        var self = this;

        if (profile && profile.name) {
            self.faceRecognition.registeredFaces = self.faceRecognition.registeredFaces.filter(function(face) {
                return face.name.toLowerCase() !== String(profile.name).toLowerCase();
            });
            self.faceRecognition.registeredFaces.push({
                name: profile.name,
                age: profile.age || '',
                threatLevel: profile.threatLevel || '',
                nationality: profile.nationality || '',
                crimeInvolvement: profile.crimeInvolvement || '',
                descriptor: Array.from(new Float32Array(profile.descriptor))
            });
        }

        self.persistStoredFaces(self.faceRecognition.registeredFaces);
        self.rebuildMatcher();
        self.updateKnownFacesList();
        self.renderProfileManager();
        self.setFaceStatus('Saved profile to browser cache.', 'success');
        return Promise.resolve({ profile: profile, savedLocally: true });
    },

    rebuildMatcher: function() {
        var self = this;

        if (typeof faceapi === 'undefined') {
            this.faceRecognition.matcher = null;
            return;
        }

        if (!this.faceRecognition.registeredFaces.length) {
            this.faceRecognition.matcher = null;
            return;
        }

        var descriptors = this.faceRecognition.registeredFaces.map(function(face) {
            return new faceapi.LabeledFaceDescriptors(face.name, [new Float32Array(face.descriptor)]);
        });

        this.faceRecognition.matcher = new faceapi.FaceMatcher(descriptors, 0.6);

        if (self.faceRecognition.statusEl && self.faceRecognition.registeredFaces.length) {
            self.setFaceStatus('Face recognition is ready for known faces.', 'success');
        }
    },

    updateKnownFacesList: function() {
        var knownFacesList = document.getElementById('known-faces');

        if (!knownFacesList) {
            return;
        }

        if (!this.faceRecognition.registeredFaces.length) {
            knownFacesList.textContent = 'No known faces registered yet. Upload a photo to add one.';
            return;
        }

        knownFacesList.textContent = this.faceRecognition.registeredFaces.map(function(face) {
            return face.name;
        }).join(', ');
    },

    renderProfileManager: function() {
        var profileManagerList = document.getElementById('profile-manager-list');

        if (!profileManagerList) {
            return;
        }

        profileManagerList.innerHTML = '';

        if (!this.faceRecognition.registeredFaces.length) {
            var emptyState = document.createElement('p');
            emptyState.className = 'profile-manager__empty';
            emptyState.textContent = 'No saved profiles yet.';
            profileManagerList.appendChild(emptyState);
            return;
        }

        this.faceRecognition.registeredFaces.forEach(function(face) {
            var card = document.createElement('article');
            card.className = 'profile-card';

            var info = document.createElement('div');
            var name = document.createElement('div');
            name.className = 'profile-card__name';
            name.textContent = face.name;

            var meta = document.createElement('div');
            meta.className = 'profile-card__meta';

            var details = [];

            if (face.age === '' || face.age === null || typeof face.age === 'undefined') {
                details.push('Age: not set');
            } else {
                details.push('Age: ' + face.age);
            }

            details.push('Threat: ' + (face.threatLevel ? face.threatLevel : 'not set'));
            details.push('Nationality: ' + (face.nationality ? face.nationality : 'not set'));
            details.push('Crime: ' + (face.crimeInvolvement ? face.crimeInvolvement : 'not set'));

            meta.textContent = details.join(' · ');

            info.appendChild(name);
            info.appendChild(meta);

            var deleteButton = document.createElement('button');
            deleteButton.type = 'button';
            deleteButton.className = 'profile-card__delete';
            deleteButton.textContent = 'Delete';
            deleteButton.setAttribute('data-delete-face', face.name);

            card.appendChild(info);
            card.appendChild(deleteButton);
            profileManagerList.appendChild(card);
        });
    },

    deleteSavedFace: function(name) {
        var self = this;

        if (!name) {
            return Promise.resolve();
        }

        self.faceRecognition.registeredFaces = self.faceRecognition.registeredFaces.filter(function(face) {
            return face.name.toLowerCase() !== String(name).toLowerCase();
        });

        self.persistStoredFaces(self.faceRecognition.registeredFaces);
        self.rebuildMatcher();
        self.updateKnownFacesList();
        self.renderProfileManager();
        self.showRecognizedDetails(null);
        self.setFaceStatus('Deleted profile from browser cache.', 'success');
        return Promise.resolve();
    },

    getRegisteredFace: function(name) {
        if (!name) {
            return null;
        }

        return this.faceRecognition.registeredFaces.find(function(face) {
            return face.name.toLowerCase() === String(name).toLowerCase();
        }) || null;
    },

    showRecognizedDetails: function(profile) {
        var recognizedDetails = document.getElementById('recognized-details');
        var recognizedName = document.getElementById('recognized-name');
        var recognizedAge = document.getElementById('recognized-age');

        var recognizedThreat = document.getElementById('recognized-threat');
        var recognizedNationality = document.getElementById('recognized-nationality');
        var recognizedCrime = document.getElementById('recognized-crime');

        if (!recognizedDetails || !recognizedName || !recognizedAge || !recognizedThreat || !recognizedNationality || !recognizedCrime) {
            return;
        }

        if (!profile) {
            recognizedDetails.classList.add('hidden');
            recognizedName.textContent = 'No person recognized yet.';
            recognizedAge.textContent = 'Age not set';
            recognizedThreat.textContent = 'Threat level not set';
            recognizedNationality.textContent = 'Nationality not set';
            recognizedCrime.textContent = 'Crime involvement not set';
            return;
        }

        recognizedDetails.classList.remove('hidden');
        recognizedName.textContent = profile.name || 'Unknown person';

        if (profile.age === '' || profile.age === null || typeof profile.age === 'undefined') {
            recognizedAge.textContent = 'Age not set';
        } else {
            recognizedAge.textContent = 'Age: ' + profile.age;
        }

        recognizedThreat.textContent = 'Threat level: ' + (profile.threatLevel ? profile.threatLevel : 'not set');
        recognizedNationality.textContent = 'Nationality: ' + (profile.nationality ? profile.nationality : 'not set');
        recognizedCrime.textContent = 'Crime involvement: ' + (profile.crimeInvolvement ? profile.crimeInvolvement : 'not set');
    },

    setFaceStatus: function(message, type) {
        if (!this.faceRecognition.statusEl) {
            return;
        }

        this.faceRecognition.statusEl.textContent = message;
        this.faceRecognition.statusEl.className = 'status face-status' + (type ? ' ' + type : '');
        this.faceRecognition.lastFaceState = message;
    },

    registerKnownFace: function(name, file) {
        var self = this;
        var faceAgeInput = document.getElementById('face-age');
        var faceNameInput = document.getElementById('face-name');
        var faceUpload = document.getElementById('face-upload');

        this.setFaceStatus('Registering ' + name + '...', 'loading');

        return this.loadFaceModels().then(function() {
            return new Promise(function(resolve, reject) {
                var reader = new FileReader();

                reader.onload = function() {
                    resolve(reader.result);
                };

                reader.onerror = function() {
                    reject(new Error('Could not read the selected photo.'));
                };

                reader.readAsDataURL(file);
            });
        }).then(function(dataUrl) {
            return faceapi.fetchImage(dataUrl);
        }).then(function(image) {
            return faceapi.detectSingleFace(image, new faceapi.TinyFaceDetectorOptions()).withFaceLandmarks().withFaceDescriptor();
        }).then(function(result) {
            if (!result) {
                throw new Error('No face was found in that photo.');
            }

            var age = faceAgeInput && faceAgeInput.value ? faceAgeInput.value.trim() : '';
            var threatLevelInput = document.getElementById('face-threat');
            var nationalityInput = document.getElementById('face-nationality');
            var crimeInput = document.getElementById('face-crime');

            var profile = {
                name: name,
                age: age,
                threatLevel: threatLevelInput && threatLevelInput.value ? threatLevelInput.value : '',
                nationality: nationalityInput && nationalityInput.value ? nationalityInput.value.trim() : '',
                crimeInvolvement: crimeInput && crimeInput.value ? crimeInput.value.trim() : '',
                descriptor: Array.from(result.descriptor)
            };

            return self.saveSavedFaces(profile).then(function() {
                self.setFaceStatus('Registered ' + name + ' for recognition.', 'success');

                if (faceNameInput) {
                    faceNameInput.value = '';
                }

                if (faceAgeInput) {
                    faceAgeInput.value = '';
                }

                if (faceUpload) {
                    faceUpload.value = '';
                }

                var threatLevelInput = document.getElementById('face-threat');
                var nationalityInput = document.getElementById('face-nationality');
                var crimeInput = document.getElementById('face-crime');

                if (threatLevelInput) {
                    threatLevelInput.value = '';
                }

                if (nationalityInput) {
                    nationalityInput.value = '';
                }

                if (crimeInput) {
                    crimeInput.value = '';
                }
            });
        }).catch(function(err) {
            self.setFaceStatus(err.message || 'Unable to register that face.', 'error');
            throw err;
        });
    },

    recognizeFrame: function(canvas) {
        var self = this;

        if (!this.faceRecognition.modelsReady) {
            return Promise.resolve({ type: 'loading', message: 'Face recognition models are still loading.' });
        }

        if (typeof faceapi === 'undefined') {
            return Promise.resolve({ type: 'error', message: 'Face recognition is unavailable.' });
        }

        return faceapi.detectSingleFace(canvas, new faceapi.TinyFaceDetectorOptions()).withFaceLandmarks().withFaceDescriptor()
            .then(function(result) {
                if (!result) {
                    self.showRecognizedDetails(null);

                    if (self.faceRecognition.matcher) {
                        return { type: 'warning', message: 'Face not detected in the current frame.' };
                    }

                    return { type: 'warning', message: 'No face detected yet. Register a face to start recognition.' };
                }

                if (!self.faceRecognition.matcher) {
                    self.showRecognizedDetails(null);
                    return { type: 'warning', message: 'A face is visible, but no known faces are registered yet.' };
                }

                var match = self.faceRecognition.matcher.findBestMatch(result.descriptor);

                if (match.label === 'unknown') {
                    self.showRecognizedDetails(null);
                    return { type: 'warning', message: 'Face detected, but it is not recognized.' };
                }

                var profile = self.getRegisteredFace(match.label);
                self.showRecognizedDetails(profile);
                return { type: 'success', message: 'Recognized: ' + match.label, profile: profile };
            });
    },

    utils: {
        diff: function(array1, array2) {
            return array1.filter(function(i) {
                return array2.indexOf(i) > -1;
            });
        },

        countChangedPixels: function(previousFrame, currentFrame, tolerance) {
            var previousData = previousFrame && previousFrame.data ? previousFrame.data : [];
            var currentData = currentFrame && currentFrame.data ? currentFrame.data : [];
            var length = Math.min(previousData.length, currentData.length);
            var count = 0;
            var i;

            tolerance = tolerance || 20;

            for (i = 0; i < length; i += 4) {
                if (Math.abs(previousData[i] - currentData[i]) > tolerance ||
                    Math.abs(previousData[i + 1] - currentData[i + 1]) > tolerance ||
                    Math.abs(previousData[i + 2] - currentData[i + 2]) > tolerance) {
                    count += 1;
                }
            }

            return count;
        },

        motionThreshold: function(width, height, ratio) {
            ratio = ratio || 0.01;
            return Math.max(100, Math.floor((width * height) * ratio));
        },

        equal: function(a, b, tolerance) {
            return this.countChangedPixels(a, b, tolerance) === 0;
        }
    },

    connect: function() {
        if (this.channel) {
            return;
        }

        if (typeof BroadcastChannel !== 'undefined') {
            this.channel = new BroadcastChannel(this.channelName);
            return;
        }

        this.useStorageFallback = true;
    },

    publishImage: function(imageData) {
        if (this.channel) {
            this.channel.postMessage({ image: imageData });
            return;
        }

        if (this.useStorageFallback) {
            localStorage.setItem(this.channelName, JSON.stringify({ image: imageData, ts: Date.now() }));
        }
    },

    subscribe: function(callback) {
        if (this.channel) {
            this.channel.onmessage = function(event) {
                callback(event.data);
            };
            return;
        }

        if (this.useStorageFallback) {
            window.addEventListener('storage', function(event) {
                if (event.key !== App.channelName || !event.newValue) {
                    return;
                }

                try {
                    callback(JSON.parse(event.newValue));
                } catch (err) {
                    console.warn('MotionDetection: failed to parse storage payload.', err);
                }
            });
        }
    },

    sendImage: function(image) {
        this.publishImage(image);
    },

    view: function() {
        var dump = $('.imageDump');

        this.subscribe(function(data) {
            if (!data || !data.image) {
                return;
            }

            console.log(data);
            var image = new Image();
            image.src = data.image;
            dump.prepend(image);
        });
    }
};

$(function() {
    App.connect();
    App.init('#container');
});