import GUI, { TABS } from "../gui";
import { i18n } from "../localization";
import $ from "jquery";
import { compareSemanticVersions } from "../elrsWebFlasher/version.js";
import { uidBytesFromText } from "../elrsWebFlasher/phrase.js";
import { resetState, store as elrsStore } from "../elrsWebFlasher/state.js";
import { generateFirmware } from "../elrsWebFlasher/firmware.js";
import { XmodemFlasher } from "../elrsWebFlasher/xmodem.js";
import { ESPFlasher } from "../elrsWebFlasher/espflasher.js";
import { MismatchError, WrongMCU } from "../elrsWebFlasher/error.js";

const elrs_flasher = {};

// State variables
let firmware = null;
let flashBranch = false;
let hardware = null;
let versions = [];
let vendors = [];
let radios = [];
let targets = [];
let luaUrl = null;

// Store object for compatibility
const store = {
    currentStep: 1,
    firmware: null,
    folder: "",
    targetType: null,
    version: null,
    vendor: null,
    vendor_name: "",
    radio: null,
    target: null,
    name: "",
    options: {
        uid: null,
        region: "FCC",
        domain: 1,
        ssid: null,
        password: null,
        wifiOnInternal: 60,
        flashMethod: null,
        tx: {
            telemetryInterval: 240,
            uartInverted: true,
            fanMinRuntime: 30,
            higherPower: false,
            melodyType: 3,
            melodyTune: null,
        },
        rx: {
            uartBaud: 420000,
            lockOnFirstConnect: true,
            r9mmMiniSBUS: false,
            fanMinRuntime: 30,
            rxAsTx: false,
            rxAsTxType: 0, // 0 = Internal (Full-duplex), 1 = External (Half-duplex)
        },
    },
};

const radioTitles = {
    tx_2400: "2.4GHz Transmitter",
    tx_900: "900MHz Transmitter",
    tx_dual: "Dual 2.4GHz/900MHz Transmitter",
    rx_2400: "2.4GHz Receiver",
    rx_900: "900MHz Receiver",
    rx_dual: "Dual 2.4GHz/900MHz Receiver",
};

function updateVersions() {
    if (firmware) {
        hardware = null;
        store.version = null;
        versions = [];
        if (flashBranch) {
            Object.entries(firmware.branches).forEach(([key, value]) => {
                versions.push({ title: key, value: value });
                if (!store.version) store.version = value;
            });
            Object.entries(firmware.tags).forEach(([key, value]) => {
                if (key.indexOf("-") !== -1) versions.push({ title: key, value: value });
            });
            versions = versions.sort((a, b) => a.title.localeCompare(b.title));
        } else {
            let first = true;
            Object.keys(firmware.tags)
                .sort(compareSemanticVersions)
                .reverse()
                .forEach((key) => {
                    if (key.indexOf("-") === -1 || first) {
                        versions.push({ title: key, value: firmware.tags[key] });
                        if (!store.version && key.indexOf("-") === -1) store.version = firmware.tags[key];
                        first = false;
                    }
                });
        }
        updateVendors();
    }
}

function updateVendors() {
    if (store.version) {
        store.folder = `./assets/${store.firmware}`;

        fetch(`./assets/${store.firmware}/hardware/targets.json`)
            .then((r) => r.json())
            .then((r) => {
                hardware = r;
                store.vendor = null;
                vendors = [];
                for (const [k, v] of Object.entries(hardware)) {
                    let hasTargets = false;
                    Object.keys(v).forEach((type) => (hasTargets |= type.startsWith(store.targetType)));
                    if (hasTargets && v.name) vendors.push({ title: v.name, value: k });
                }
                vendors.sort((a, b) => a.title.localeCompare(b.title));

                // Try to set default vendor if available
                const defaultVendor = "hdzero";
                if (vendors.some((v) => v.value === defaultVendor)) {
                    store.vendor = defaultVendor;
                }

                // Update the UI
                populateVendors();
                updateRadios();
            })
            .catch((_ignore) => {
                // Handle error silently
                vendors = [];
                populateVendors();
            });
    } else {
        vendors = [];
        populateVendors();
    }
}

function updateRadios() {
    radios = [];
    let keepTarget = false;
    if (store.vendor && hardware) {
        Object.keys(hardware[store.vendor]).forEach((k) => {
            if (k.startsWith(store.targetType)) radios.push({ title: radioTitles[k], value: k });
            if (store.target && store.target.vendor === store.vendor && store.target.radio === k) keepTarget = true;
        });
        if (radios.length === 1) {
            store.radio = radios[0].value;
            keepTarget = true;
        }
    }
    if (!keepTarget) store.radio = null;

    // Update the UI
    populateRadios();
    updateTargets();
}

function updateTargets() {
    targets = [];
    let keepTarget = false;
    if (store.version && hardware) {
        const version = versions.find((x) => x.value === store.version).title;
        for (const [vk, v] of Object.entries(hardware)) {
            if (vk === store.vendor || store.vendor === null) {
                for (const [rk, r] of Object.entries(v)) {
                    if (rk.startsWith(store.targetType) && (rk === store.radio || store.radio === null)) {
                        for (const [ck, c] of Object.entries(r)) {
                            if (flashBranch || compareSemanticVersions(version, c.min_version) >= 0) {
                                targets.push({
                                    title: c.product_name,
                                    value: { vendor: vk, radio: rk, target: ck, config: c },
                                });
                                if (
                                    store.target &&
                                    store.target.vendor === vk &&
                                    store.target.radio === rk &&
                                    store.target.target === ck
                                )
                                    keepTarget = true;
                            }
                        }
                    }
                }
            }
        }
    }
    targets.sort((a, b) => a.title.localeCompare(b.title));
    if (!keepTarget) store.target = null;

    // Update the UI
    populateTargets();
    updateLuaUrl();
}

function updateLuaUrl() {
    luaUrl = store.version ? `./assets/${store.firmware}/${store.version}/lua/elrsV3.lua` : null;
}

function flashType() {
    return flashBranch ? "Branches" : "Releases";
}

// UI population functions - moved outside initialize so they can be called by update functions
function populateFirmwareVersions() {
    const select = $('select[name="firmware_version"]');
    select.empty();
    select.append('<option value="">Loading...</option>');

    // Load firmware data
    fetch(`./assets/${store.firmware}/index.json`)
        .then((r) => r.json())
        .then((r) => {
            firmware = r;
            updateVersions();

            select.empty();
            versions.forEach((version) => {
                select.append(`<option value="${version.value}">${version.title}</option>`);
            });
        })
        .catch((error) => {
            console.error("Error loading firmware versions:", error);
            select.empty();
            select.append('<option value="">Error loading versions</option>');
        });
}

function populateVendors() {
    const select = $('select[name="hardware-vendor"]');
    select.empty();

    if (vendors.length === 0) {
        select.append('<option value="">Select firmware version first</option>');
    } else {
        select.append('<option value="">Select vendor...</option>');
        vendors.forEach((vendor) => {
            select.append(`<option value="${vendor.value}">${vendor.title}</option>`);
        });

        // Set the selected value if we have a default vendor
        if (store.vendor) {
            select.val(store.vendor);
        }
    }
}

function populateRadios() {
    const select = $('select[name="radio-frequency"]');
    select.empty();

    if (radios.length === 0) {
        select.append('<option value="">Select vendor first</option>');
    } else {
        select.append('<option value="">Select radio type...</option>');
        radios.forEach((radio) => {
            select.append(`<option value="${radio.value}">${radio.title}</option>`);
        });
    }
}

function populateTargets() {
    const select = $('select[name="hardware-target"]');
    select.empty();

    if (targets.length === 0) {
        select.append('<option value="">Select radio type first</option>');
    } else {
        select.append('<option value="">Select hardware target...</option>');
        targets.forEach((target) => {
            select.append(`<option value="${target.value.target}">${target.title}</option>`);
        });
    }
}

elrs_flasher.initialize = function (callback) {
    if (GUI.active_tab != "elrs_flasher") {
        GUI.active_tab = "elrs_flasher";
    }

    function load_html() {
        $("#content").load("./tabs/elrs_flasher.html", process_html);
    }

    function process_html() {
        // Initialize the UI - only populate firmware versions initially
        populateFirmwareVersions();
        populateVendors();
        populateRadios();
        populateTargets();
        populateFlashMethods();
        populateRegulatoryDomains();

        // Set up event handlers
        setupEventHandlers();
        setupBindPhraseInput();
        const updateWiFiVisibility = setupWiFiSettings();

        // Store the update function for later use
        window.updateWiFiVisibility = updateWiFiVisibility;

        // translate to user-selected language
        i18n.localizePage();

        GUI.content_ready(callback);
    }

    function setupEventHandlers() {
        // Firmware version change
        $('select[name="firmware_version"]').on("change", function () {
            store.version = $(this).val();
            updateVendors();
        });

        // Vendor change
        $('select[name="hardware-vendor"]').on("change", function () {
            store.vendor = $(this).val();
            updateRadios();
        });

        // Radio change
        $('select[name="radio-frequency"]').on("change", function () {
            store.radio = $(this).val();
            updateTargets();
        });

        // Target change
        $('select[name="hardware-target"]').on("change", function () {
            const targetValue = $(this).val();
            store.target = targets.find((t) => t.value.target === targetValue)?.value || null;
            if (store.target) {
                store.vendor = store.target.vendor;
                store.radio = store.target.radio;

                // Update flash methods based on target capabilities
                populateFlashMethods();

                // Update regulatory domains based on radio type
                populateRegulatoryDomains();

                // Update WiFi settings visibility
                if (window.updateWiFiVisibility) {
                    window.updateWiFiVisibility();
                }

                // Update button state - enable when target is selected
                updateFlashButton();
            } else {
                // If no target selected, reset flash methods
                populateFlashMethods();

                // Update regulatory domains
                populateRegulatoryDomains();

                // Update WiFi settings visibility
                if (window.updateWiFiVisibility) {
                    window.updateWiFiVisibility();
                }

                // Update button state - disable when no target
                updateFlashButton();
            }
        });

        // Flash method change
        $('select[name="flashing-method"]').on("change", function () {
            const selectedMethod = $(this).val();
            store.options.flashMethod = selectedMethod;
            updateFlashButton();
        });

        // Region change
        $('select[name="region"]').on("change", function () {
            const selectedRegion = $(this).val();
            store.options.region = selectedRegion;
        });

        // Domain change
        $('select[name="domain"]').on("change", function () {
            const selectedDomain = parseInt($(this).val());
            store.options.domain = selectedDomain;
        });

        // Connect device button
        $(".connect_device").on("click", function (e) {
            e.preventDefault();
            handleDeviceFlashing();
        });

        // Flashing interface event handlers
        $(".flash_button").on("click", function () {
            fullErase = $('input[name="full_erase"]').is(":checked");
            flash();
        });

        $(".flash_anyway_button").on("click", function () {
            fullErase = $('input[name="full_erase"]').is(":checked");
            flash();
        });

        $(".try_again_button").on("click", function () {
            closeDevice();
        });

        $(".flash_another_button").on("click", function () {
            another();
        });

        $(".back_to_start_button").on("click", function () {
            reset();
        });

        // Flash firmware button
        $(".flash_firmware").on("click", function (e) {
            e.preventDefault();

            // Check if we have all required data
            if (!store.target || !store.options.flashMethod) {
                alert("Please select a target and flash method first.");
                return;
            }

            // Handle different flash methods
            if (store.options.flashMethod === "download") {
                // Handle local download
                downloadFirmware();
            } else {
                // Handle device flashing
                handleDeviceFlashing();
            }
        });
    }

    // Initialize with default values
    store.firmware = "firmware"; // Default firmware type
    store.targetType = "rx"; // Default target type

    load_html();
};

elrs_flasher.cleanup = function (callback) {
    if (callback) callback();
};

// Flash method titles mapping
const flashMethodTitles = {
    download: "Local Download",
    uart: "Serial UART",
    betaflight: "Betaflight Passthrough",
    etx: "EdgeTX Passthrough",
    passthru: "Passthrough",
    wifi: "WiFi",
    stlink: "STLink",
    dfu: "DFU",
    stock: "Stock Bootloader",
};

// Flash methods available in ELRS
const flashMethods = [
    { value: "download", title: "Local Download" },
    { value: "uart", title: "Serial UART" },
    { value: "betaflight", title: "Betaflight Passthrough" },
    { value: "etx", title: "EdgeTX Passthrough" },
    { value: "passthru", title: "Passthrough" },
    { value: "wifi", title: "WiFi" },
    { value: "stlink", title: "STLink" },
    { value: "dfu", title: "DFU" },
    { value: "stock", title: "Stock Bootloader" },
];

function getFlashMethods(methods) {
    return flashMethods.filter((v) => v.value === "download" || (methods && methods.includes(v.value)));
}

function populateFlashMethods() {
    const select = $('select[name="flashing-method"]');
    select.empty();
    select.append('<option value="">Select flashing method...</option>');

    // Get available methods from target configuration
    const availableMethods = store.target?.config?.upload_methods || [];
    const methods = getFlashMethods(availableMethods);

    methods.forEach((method) => {
        select.append(`<option value="${method.value}">${method.title}</option>`);
    });

    // Set default value if available
    if (methods.length > 0) {
        select.val("download");
        store.options.flashMethod = "download";
    }
}

// Regulatory domain functionality
const regions = [
    { value: "FCC", title: "FCC" },
    { value: "LBT", title: "LBT" },
];

const domains = [
    { value: 0, title: "AU915" },
    { value: 1, title: "FCC915" },
    { value: 2, title: "EU868" },
    { value: 3, title: "IN866" },
    { value: 4, title: "AU433" },
    { value: 5, title: "EU433" },
    { value: 6, title: "US433" },
    { value: 7, title: "US433-Wide" },
];

function hasHighFrequency() {
    return store.radio && (store.radio.endsWith("2400") || store.radio.endsWith("dual"));
}

function hasLowFrequency() {
    return store.radio && (store.radio.endsWith("900") || store.radio.endsWith("dual"));
}

function populateRegulatoryDomains() {
    const regionSelect = $('select[name="region"]');
    const domainSelect = $('select[name="domain"]');

    // Clear existing options
    regionSelect.empty();
    domainSelect.empty();

    // Add region options if high frequency
    if (hasHighFrequency()) {
        regionSelect.append('<option value="">Select region...</option>');
        regions.forEach((region) => {
            regionSelect.append(`<option value="${region.value}">${region.title}</option>`);
        });
        regionSelect.val(store.options.region);
        regionSelect.closest("tr").show();
    } else {
        regionSelect.closest("tr").hide();
    }

    // Add domain options if low frequency
    if (hasLowFrequency()) {
        domainSelect.append('<option value="">Select regulatory domain...</option>');
        domains.forEach((domain) => {
            domainSelect.append(`<option value="${domain.value}">${domain.title}</option>`);
        });
        domainSelect.val(store.options.domain);
        domainSelect.closest("tr").show();
    } else {
        domainSelect.closest("tr").hide();
    }
}

// Bind phrase functionality
function generateUID(bindPhrase) {
    if (!bindPhrase || bindPhrase === "") {
        store.options.uid = null;
        return "Bind Phrase";
    } else {
        try {
            const uidBytes = uidBytesFromText(bindPhrase);
            const uidHex = Array.from(uidBytes)
                .map((b) => b.toString(16).padStart(2, "0"))
                .join("");
            store.options.uid = uidBytes;
            return `UID: ${  uidHex}`;
        } catch (error) {
            console.error("Error generating UID:", error);
            store.options.uid = null;
            return "Bind Phrase";
        }
    }
}

function setupBindPhraseInput() {
    const input = $('input[name="bind-phrase"]');
    const label = input.attr("placeholder") || "Bind Phrase";

    // Set initial placeholder
    input.attr("placeholder", label);

    // Handle input changes
    input.on("input", function () {
        const bindPhrase = $(this).val();
        const uidLabel = generateUID(bindPhrase);

        // Update the placeholder to show the UID
        if (uidLabel.startsWith("UID: ")) {
            $(this).attr("placeholder", uidLabel);
        } else {
            $(this).attr("placeholder", label);
        }
    });
}

// WiFi settings functionality
function setupWiFiSettings() {
    const ssidInput = $('input[name="wifi-ssid"]');
    const passwordInput = $('input[name="wifi-password"]');

    // Check if WiFi settings should be shown (not for STM32 platforms)
    function updateWiFiVisibility() {
        const shouldShow = store.target && store.target.config && store.target.config.platform !== "stm32";
        const wifiRow = ssidInput.closest("tr");

        if (shouldShow) {
            wifiRow.show();
        } else {
            wifiRow.hide();
            // Clear values when hidden
            store.options.ssid = null;
            store.options.password = null;
            ssidInput.val("");
            passwordInput.val("");
        }
    }

    // Handle SSID input changes
    ssidInput.on("input", function () {
        store.options.ssid = $(this).val() || null;
    });

    // Handle password input changes
    passwordInput.on("input", function () {
        store.options.password = $(this).val() || null;
    });

    // Add password visibility toggle
    const passwordToggle = $(
        '<button type="button" class="password-toggle" style="position: absolute; right: 10px; top: 50%; transform: translateY(-50%); background: none; border: none; cursor: pointer; font-size: 16px;">👁</button>',
    );

    // Wrap password input in a relative container for the toggle button
    const passwordContainer = $('<div style="position: relative;"></div>');
    passwordInput.wrap(passwordContainer);
    passwordContainer.append(passwordToggle);

    let showPassword = false;

    passwordToggle.on("click", function () {
        showPassword = !showPassword;
        passwordInput.attr("type", showPassword ? "text" : "password");
        $(this).text(showPassword ? "🙈" : "👁");
    });

    // Initial visibility check
    updateWiFiVisibility();

    // Update visibility when target changes
    return updateWiFiVisibility;
}

function updateFlashButton() {
    const button = $(".flash_firmware");

    // Check if we have required data - only need target for download
    const hasTarget = store.target && store.target.config;

    if (hasTarget) {
        button.removeClass("disabled");

        // Update button text based on flash method
        if (store.options.flashMethod === "download") {
            button.text("Local download");
        } else {
            button.text("Flash Firmware");
        }
    } else {
        button.addClass("disabled");
        button.text("Flash Firmware");
    }
}

// Firmware generation and download functionality
const files = {
    firmwareFiles: [],
    config: null,
    firmwareUrl: "",
    options: {},
    deviceType: null,
    radioType: undefined,
    txType: undefined,
};

// Flashing state variables
let step = 1;
let enableFlash = false;
let allowErase = true;
let fullErase = false;
let flashComplete = false;
let failed = false;
let log = [];
let newline = false;
let noDevice = false;
let flasher;
let device = null;
let progress = 0;
let progressText = "";

async function buildFirmware() {
    // Validate that we have all required data
    if (!store.target) {
        throw new Error("No target selected. Please select a hardware target first.");
    }

    if (!store.target.config) {
        throw new Error("Target configuration is missing. Please select a valid target.");
    }

    if (!store.options.flashMethod) {
        throw new Error("No flash method selected. Please select a flashing method.");
    }

    // Set currentStep to 3 to indicate we're ready to build firmware
    store.currentStep = 3;

    // Sync our store with the ELRS web flasher's store
    syncStoreWithELRS();

    try {
        // Debug: Log the current store state
        console.log("Current store state:", {
            target: store.target,
            targetType: store.targetType,
            firmware: store.firmware,
            version: store.version,
            radio: store.radio,
            options: store.options,
        });

        const [binary, { config, firmwareUrl, options, deviceType, radioType, txType }] = await generateFirmware();

        files.firmwareFiles = binary;
        files.firmwareUrl = firmwareUrl;
        files.config = config;
        files.options = options;
        files.deviceType = deviceType;
        files.radioType = radioType;
        files.txType = txType;

        fullErase = false;
        allowErase = !(store.target.config.platform.startsWith("esp32") && store.options.flashMethod === "betaflight");
    } catch (error) {
        console.error("Error building firmware:", error);
        throw error; // Re-throw to let calling function handle it
    }
}

async function downloadFirmware() {
    try {
        // Build firmware first
        await buildFirmware();
    } catch (error) {
        alert(`Error building firmware: ${  error.message}`);
        return;
    }

    try {
        let data, filename;

        if (store.target.config.platform === "esp8285") {
            // For ESP8285, create gzipped firmware
            // Note: In a real implementation, you'd use pako.gzip here
            const bin = files.firmwareFiles[files.firmwareFiles.length - 1].data;
            data = new Blob([bin], { type: "application/octet-stream" });
            filename = "firmware.bin.gz";
        } else if (store.target.config.upload_methods && store.target.config.upload_methods.includes("zip")) {
            // For ZIP upload method, create a ZIP file
            // Note: In a real implementation, you'd use zip.js here
            const bin = files.firmwareFiles[files.firmwareFiles.length - 1].data;
            data = new Blob([bin], { type: "application/octet-stream" });
            filename = "firmware.zip";
        } else {
            // Standard binary firmware
            const bin = files.firmwareFiles[files.firmwareFiles.length - 1].data;
            data = new Blob([bin], { type: "application/octet-stream" });
            filename = "firmware.bin";
        }

        // Create download link
        const url = URL.createObjectURL(data);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        // Clean up
        URL.revokeObjectURL(url);
    } catch (error) {
        console.error("Error downloading firmware:", error);
        alert(`Error downloading firmware: ${  error.message}`);
    }
}

async function closeDevice() {
    if (flasher) {
        try {
            await flasher.close();
        } catch (error) {
            // Ignore errors on close
        }
        flasher = null;
        device = null;
    }
    if (device != null) {
        try {
            await device.close();
        } catch (error) {
            // Ignore errors on close
        }
    }
    device = null;
    enableFlash = false;
    flashComplete = false;
    failed = false;
    step = 1;
    log = [];
    progress = 0;

    updateFlashingUI();
}

async function connect() {
    try {
        device = await navigator.serial.requestPort();
        device.ondisconnect = async (_p, _e) => {
            console.log("disconnected");
            await closeDevice();
        };
    } catch {
        await closeDevice();
        noDevice = true;
        updateNoDeviceSnackbar();
        return;
    }

    if (device) {
        step++;
        updateFlashingUI();

        const method = store.options.flashMethod;
        let term = {
            write: (e) => {
                // Log to console only
                console.log("Device:", e);
            },
            writeln: (e) => {
                // Log to console only
                console.log("Device:", e);
            },
        };

        if (store.target.config.platform === "stm32") {
            flasher = new XmodemFlasher(
                device,
                files.deviceType,
                method,
                files.config,
                files.options,
                files.firmwareUrl,
                term,
            );
        } else {
            flasher = new ESPFlasher(
                device,
                files.deviceType,
                method,
                files.config,
                files.options,
                files.firmwareUrl,
                term,
            );
        }

        try {
            await flasher.connect();
            enableFlash = true;
            updateFlashingUI();
        } catch (e) {
            if (e instanceof MismatchError) {
                term.writeln("Target mismatch, flashing cancelled");
                failed = true;
                enableFlash = true;
            } else if (e instanceof WrongMCU) {
                term.writeln(e.message);
                failed = true;
            } else {
                console.log(e);
                term.writeln("Failed to connect to device, restart device and try again");
                failed = true;
            }
            updateFlashingUI();
        }
    }
}

async function another() {
    await closeDevice();
    await connect();
}

async function reset() {
    await closeDevice();
    resetState();
}

async function flash() {
    failed = false;
    step++;
    updateFlashingUI();

    try {
        progressText = "";
        await flasher.flash(files.firmwareFiles, fullErase, (fileIndex, written, total) => {
            progressText = `${fileIndex + 1  } of ${  files.firmwareFiles.length}`;
            progress = Math.round((written / total) * 100);
            updateFlashingUI();
        });
        await flasher.close();
        flasher = null;
        device = null;
        flashComplete = true;
        step++;
        updateFlashingUI();
    } catch (e) {
        console.log(e);
        failed = true;
        updateFlashingUI();
    }
}

// UI update functions for flashing interface
function updateFlashingUI() {
    // Show/hide flashing interface
    const flashingInterface = $(".flashing_interface");
    const mainInterface = $(".tab-elrs_flasher");

    if (step > 1) {
        flashingInterface.show();
        mainInterface.hide();
    } else {
        flashingInterface.hide();
        mainInterface.show();
    }

    // Update step visibility
    $(".step").hide();
    $(`.step[data-step="${step}"]`).show();

    // Update step-specific content
    if (step === 1) {
        $(".connect_device").show();
    } else if (step === 2) {
        // Show flash options if enabled
        if (enableFlash) {
            $(".flash_options").show();
            if (allowErase) {
                $('input[name="full_erase"]').show();
            } else {
                $('input[name="full_erase"]').hide();
            }

            if (!failed) {
                $(".flash_button").show();
            } else {
                $(".flash_anyway_button").show();
            }
            $(".try_again_button").show();
        }
    } else if (step === 3) {
        // Update the existing progress bar in the toolbar
        $(".content_toolbar .progress").val(progress);
        $(".content_toolbar .progressLabel").text(progressText || "Erasing flash, please wait...");

        if (failed) {
            $(".flash_failed").show();
        }
    } else if (step === 4) {
        // Done step - buttons are already in HTML
    }
}

function syncStoreWithELRS() {
    // Sync our store data with the ELRS web flasher's store
    elrsStore.currentStep = store.currentStep;
    elrsStore.firmware = store.firmware;
    elrsStore.folder = store.folder;
    elrsStore.targetType = store.targetType;
    elrsStore.version = store.version;
    elrsStore.vendor = store.vendor;
    elrsStore.vendor_name = store.vendor_name;
    elrsStore.radio = store.radio;
    elrsStore.target = store.target;
    elrsStore.name = store.name;

    // Sync options
    elrsStore.options.uid = store.options.uid;
    elrsStore.options.region = store.options.region;
    elrsStore.options.domain = store.options.domain;
    elrsStore.options.ssid = store.options.ssid;
    elrsStore.options.password = store.options.password;
    elrsStore.options.wifiOnInternal = store.options.wifiOnInternal;
    elrsStore.options.flashMethod = store.options.flashMethod;

    // Sync TX options
    elrsStore.options.tx.telemetryInterval = store.options.tx.telemetryInterval;
    elrsStore.options.tx.uartInverted = store.options.tx.uartInverted;
    elrsStore.options.tx.fanMinRuntime = store.options.tx.fanMinRuntime;
    elrsStore.options.tx.higherPower = store.options.tx.higherPower;
    elrsStore.options.tx.melodyType = store.options.tx.melodyType;
    elrsStore.options.tx.melodyTune = store.options.tx.melodyTune;

    // Sync RX options
    elrsStore.options.rx.uartBaud = store.options.rx.uartBaud;
    elrsStore.options.rx.lockOnFirstConnect = store.options.rx.lockOnFirstConnect;
    elrsStore.options.rx.r9mmMiniSBUS = store.options.rx.r9mmMiniSBUS;
    elrsStore.options.rx.fanMinRuntime = store.options.rx.fanMinRuntime;
    elrsStore.options.rx.rxAsTx = store.options.rx.rxAsTx;
    elrsStore.options.rx.rxAsTxType = store.options.rx.rxAsTxType;
}

function updateNoDeviceSnackbar() {
    if (noDevice) {
        $(".no_device_snackbar").show();
        setTimeout(() => {
            $(".no_device_snackbar").hide();
            noDevice = false;
        }, 5000);
    }
}

function handleDeviceFlashing() {
    // Build firmware and connect to device
    buildFirmware()
        .then(() => {
            connect();
        })
        .catch((error) => {
            alert(`Error building firmware: ${  error.message}`);
        });
}

TABS.elrs_flasher = elrs_flasher;
export { elrs_flasher };
