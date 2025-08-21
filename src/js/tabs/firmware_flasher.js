import $ from "jquery";
import { i18n } from "../localization";
import GUI, { TABS } from "../gui";
import { get as getConfig, set as setConfig } from "../ConfigStorage";
import { get as getStorage, set as setStorage } from "../SessionStorage";
import BuildApi from "../BuildApi";
import ConfigInserter from "../ConfigInserter.js";
import { tracking } from "../Analytics";
import PortHandler from "../port_handler";
import { gui_log } from "../gui_log";
import semver from "semver";
import { urlExists } from "../utils/common";
import read_hex_file from "../workers/hex_parser.js";
import FileSystem from "../FileSystem";
import STM32 from "../protocols/webstm32";
import DFU from "../protocols/webusbdfu";
import AutoBackup from "../utils/AutoBackup.js";
import AutoDetect from "../utils/AutoDetect.js";
import { EventBus } from "../../components/eventBus";
import { ispConnected } from "../utils/connection.js";
import FC from "../fc";

// ELRS Flasher imports
import { compareSemanticVersions } from "../elrsWebFlasher/version.js";
import { uidBytesFromText } from "../elrsWebFlasher/phrase.js";
import { resetState, store as elrsStore } from "../elrsWebFlasher/state.js";
import { generateFirmware } from "../elrsWebFlasher/firmware.js";
import { XmodemFlasher } from "../elrsWebFlasher/xmodem.js";
import { ESPFlasher } from "../elrsWebFlasher/espflasher.js";
import { MismatchError, WrongMCU } from "../elrsWebFlasher/error.js";

const firmware_flasher = {
    targets: null,
    buildApi: new BuildApi(),
    localFirmwareLoaded: false,
    selectedBoard: undefined,
    cloudBuildKey: null,
    cloudBuildOptions: null,
    isFlashing: false,
    intel_hex: undefined, // standard intel hex in string format
    parsed_hex: undefined, // parsed raw hex in array format
    isConfigLocal: false, // Set to true if the user loads one locally
    filename: null,
    configFilename: null,
    config: {},
    developmentFirmwareLoaded: false, // Is the firmware to be flashed from the development branch?
    cancelBuild: false,

    // ELRS Flasher state variables
    firmware: null,
    flashBranch: false,
    hardware: null,
    versions: [],
    vendors: [],
    radios: [],
    targets: [],
    luaUrl: null,

    // Store object for ELRS compatibility
    store: {
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
    },

    // ELRS Flashing state variables
    step: 1,
    enableFlash: false,
    allowErase: true,
    fullErase: false,
    flashComplete: false,
    failed: false,
    log: [],
    newline: false,
    noDevice: false,
    flasher: null,
    device: null,
    progress: 0,
    progressText: "",

    // ELRS Files object
    files: {
        firmwareFiles: [],
        config: null,
        firmwareUrl: "",
        options: {},
        deviceType: null,
        radioType: undefined,
        txType: undefined,
    },
};

// ELRS Constants and helper functions
const radioTitles = {
    tx_2400: "2.4GHz Transmitter",
    tx_900: "900MHz Transmitter",
    tx_dual: "Dual 2.4GHz/900MHz Transmitter",
    rx_2400: "2.4GHz Receiver",
    rx_900: "900MHz Receiver",
    rx_dual: "Dual 2.4GHz/900MHz Receiver",
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

firmware_flasher.initialize = async function (callback) {
    const self = this;

    if (GUI.active_tab !== "firmware_flasher") {
        GUI.active_tab = "firmware_flasher";
    }

    // reset on tab change
    self.selectedBoard = undefined;

    self.cloudBuildKey = null;
    self.cloudBuildOptions = null;

    self.localFirmwareLoaded = false;
    self.isConfigLocal = false;
    self.intel_hex = undefined;
    self.parsed_hex = undefined;

    self.logHead = "[FIRMWARE_FLASHER]";

    async function onDocumentLoad() {
        // Initialize firmware type switching
        function initializeFirmwareTypeSwitching() {
            $('select[name="firmware_type"]').on("change", function () {
                const selectedType = $(this).val();

                if (selectedType === "betaflight") {
                    $(".betaflight_firmware_content").show();
                    $(".elrs_firmware_content").hide();
                    $(".elrs_flashing_interface").hide();
                    // Reset ELRS state
                    firmware_flasher.resetELRSState();
                } else if (selectedType === "elrs") {
                    $(".betaflight_firmware_content").hide();
                    $(".elrs_firmware_content").show();
                    // Initialize ELRS flasher
                    firmware_flasher.initializeELRSFlasher();
                }
            });

            // Set default to betaflight
            $('select[name="firmware_type"]').val("betaflight").trigger("change");
        }

        // Initialize firmware type switching
        initializeFirmwareTypeSwitching();

        function parseHex(str, callback) {
            read_hex_file(str).then((data) => {
                callback(data);
            });
        }

        function showLoadedHex(filename) {
            self.filename = filename;

            if (self.localFirmwareLoaded) {
                self.flashingMessage(
                    i18n.getMessage("firmwareFlasherFirmwareLocalLoaded", {
                        filename: filename,
                        bytes: self.parsed_hex.bytes_total,
                    }),
                    self.FLASH_MESSAGE_TYPES.NEUTRAL,
                );
            } else {
                self.flashingMessage(
                    `<a class="save_firmware" href="#" title="Save Firmware">${i18n.getMessage(
                        "firmwareFlasherFirmwareOnlineLoaded",
                        { filename: filename, bytes: self.parsed_hex.bytes_total },
                    )}</a>`,
                    self.FLASH_MESSAGE_TYPES.NEUTRAL,
                );
            }
            self.enableFlashButton(true);

            tracking.sendEvent(tracking.EVENT_CATEGORIES.FLASHING, "FirmwareLoaded", {
                firmwareSize: self.parsed_hex.bytes_total,
                firmwareName: filename,
                firmwareSource: self.localFirmwareLoaded ? "file" : "http",
                selectedTarget: self.targetDetail?.target,
                selectedRelease: self.targetDetail?.release,
            });
        }

        function showReleaseNotes(summary) {
            if (summary.manufacturer) {
                $("div.release_info #manufacturer").text(summary.manufacturer);
                $("div.release_info #manufacturerInfo").show();
            } else {
                $("div.release_info #manufacturerInfo").hide();
            }

            $("div.release_info .target").text(summary.target);
            $("div.release_info .name").text(summary.release).prop("href", summary.releaseUrl);
            $("div.release_info .date").text(summary.date);
            $("div.release_info #targetMCU").text(summary.mcu);
            $("div.release_info .configFilename").text(self.isConfigLocal ? self.configFilename : "[default]");

            if (summary.cloudBuild) {
                $("div.release_info #cloudTargetInfo").show();
                $("div.release_info #cloudTargetLog").text("");
                $("div.release_info #cloudTargetStatus").text("pending");
            } else {
                $("div.release_info #cloudTargetInfo").hide();
            }

            if (self.targets) {
                $("div.release_info").slideDown();
                $(".tab-firmware_flasher .content_wrapper").animate(
                    { scrollTop: $("div.release_info").position().top },
                    1000,
                );
            }
        }

        function clearBoardConfig() {
            self.config = {};
            self.isConfigLocal = false;
            self.configFilename = null;
        }

        function setBoardConfig(config, filename) {
            self.config = config.join("\n");
            self.isConfigLocal = filename !== undefined;
            self.configFilename = filename !== undefined ? filename : null;
        }

        function loadFailed() {
            $("span.progressLabel")
                .attr("i18n", "firmwareFlasherFailedToLoadOnlineFirmware")
                .removeClass("i18n-replaced");
            self.enableLoadRemoteFileButton(true);
            $("a.load_remote_file").text(i18n.getMessage("firmwareFlasherButtonLoadOnline"));
            i18n.localizePage();
        }

        function processHex(data, key) {
            if (!data) {
                loadFailed();
                return;
            }

            self.localFirmwareLoaded = false;
            self.intel_hex = data;

            parseHex(self.intel_hex, function (data) {
                self.parsed_hex = data;

                if (self.parsed_hex) {
                    showLoadedHex(key);
                } else {
                    self.flashingMessage(
                        i18n.getMessage("firmwareFlasherHexCorrupted"),
                        self.FLASH_MESSAGE_TYPES.INVALID,
                    );
                    self.enableFlashButton(false);
                }
            });

            self.enableLoadRemoteFileButton(true);
            $("a.load_remote_file").text(i18n.getMessage("firmwareFlasherButtonLoadOnline"));
        }

        function loadTargetList(targets) {
            if (!targets || !ispConnected()) {
                $('select[name="board"]').empty().append('<option value="0">Offline</option>');
                $('select[name="firmware_version"]').empty().append('<option value="0">Offline</option>');

                return;
            }

            const boards_e = $('select[name="board"]');
            boards_e.empty();
            boards_e.append(
                $(`<option value='0'>${i18n.getMessage("firmwareFlasherOptionLabelSelectBoard")}</option>`),
            );

            const versions_e = $('select[name="firmware_version"]');
            versions_e.empty();
            versions_e.append(
                $(`<option value='0'>${i18n.getMessage("firmwareFlasherOptionLabelSelectFirmwareVersion")}</option>`),
            );

            Object.keys(targets)
                .sort((a, b) => a.target - b.target)
                .forEach(function (target, i) {
                    const descriptor = targets[target];
                    const select_e = $(`<option value='${descriptor.target}'>${descriptor.target}</option>`);
                    boards_e.append(select_e);
                });

            TABS.firmware_flasher.targets = targets;

            // For discussion. Rather remove build configuration and let user use auto-detect. Often I think already had pressed the button.
            $("div.build_configuration").slideUp();
        }

        function buildOptionsList(select_e, options) {
            select_e.empty();
            options.forEach((option) => {
                if (option.default) {
                    select_e.append($(`<option value='${option.value}' selected>${option.name}</option>`));
                } else {
                    select_e.append($(`<option value='${option.value}'>${option.name}</option>`));
                }
            });
        }

        function toggleTelemetryProtocolInfo() {
            const radioProtocol = $('select[name="radioProtocols"] option:selected').val();
            const hasTelemetryEnabledByDefault = [
                "USE_SERIALRX_CRSF",
                "USE_SERIALRX_FPORT",
                "USE_SERIALRX_GHST",
                "USE_SERIALRX_JETIEXBUS",
            ].includes(radioProtocol);

            $('select[name="telemetryProtocols"]').attr("disabled", hasTelemetryEnabledByDefault);

            if (hasTelemetryEnabledByDefault) {
                if ($('select[name="telemetryProtocols"] option[value="-1"]').length === 0) {
                    $('select[name="telemetryProtocols"]').prepend(
                        $("<option>", {
                            value: "-1",
                            selected: "selected",
                            text: i18n.getMessage("firmwareFlasherOptionLabelTelemetryProtocolIncluded"),
                        }),
                    );
                } else {
                    $('select[name="telemetryProtocols"] option:first')
                        .attr("selected", "selected")
                        .text(i18n.getMessage("firmwareFlasherOptionLabelTelemetryProtocolIncluded"));
                }
            } else if ($('select[name="telemetryProtocols"] option[value="-1"]').length) {
                $('select[name="telemetryProtocols"] option:first').remove();
            }
        }

        function updateOsdProtocolColor() {
            const osdProtocol = $('select[name="osdProtocols"] option:selected').val();
            $('select[name="osdProtocols"]')
                .next(".select2-container")
                .find(".select2-selection__rendered")
                .attr("style", osdProtocol === "" ? "color: red !important" : "");
        }

        function buildOptions(data) {
            if (!ispConnected()) {
                return;
            }

            // extract osd protocols from general options and add to osdProtocols
            console.log(`${self.logHead} buildOptions`, FC.CONFIG.buildOptions);
            self.cloudBuildOptions = FC.CONFIG.buildOptions || [];
            data.osdProtocols = data.generalOptions
                .filter((option) => option.group === "OSD")
                .map((option) => {
                    option.name = option.groupedName;
                    option.default = self.cloudBuildOptions?.includes(option.value);
                    return option;
                });

            // add None option to osdProtocols as first option
            data.osdProtocols.unshift({ name: "None", value: "" });

            // remove osdProtocols from generalOptions
            data.generalOptions = data.generalOptions.filter((option) => !option.group);

            buildOptionsList($('select[name="radioProtocols"]'), data.radioProtocols);
            buildOptionsList($('select[name="telemetryProtocols"]'), data.telemetryProtocols);
            buildOptionsList($('select[name="osdProtocols"]'), data.osdProtocols);
            buildOptionsList($('select[name="options"]'), data.generalOptions);
            buildOptionsList($('select[name="motorProtocols"]'), data.motorProtocols);

            // Using setTimeout to ensure this runs after Select2 has finished initializing/rendering
            setTimeout(updateOsdProtocolColor, 0);

            // Add change handler to update color when selection changes
            $('select[name="osdProtocols"]').on("change", updateOsdProtocolColor);

            if (!self.validateBuildKey()) {
                preselectRadioProtocolFromStorage();
            }

            toggleTelemetryProtocolInfo();
        }

        function preselectRadioProtocolFromStorage() {
            const storedRadioProtocol = getConfig("ffRadioProtocol").ffRadioProtocol;
            if (storedRadioProtocol) {
                const valueExistsInSelect =
                    $('select[name="radioProtocols"] option').filter(function (i, o) {
                        return o.value === storedRadioProtocol;
                    }).length !== 0;
                if (valueExistsInSelect) {
                    $('select[name="radioProtocols"]').val(storedRadioProtocol);
                }
            }
        }

        let buildTypesToShow;
        const buildType_e = $('select[name="build_type"]');
        function buildBuildTypeOptionsList() {
            buildType_e.empty();
            buildTypesToShow.forEach(({ tag, title }, index) => {
                buildType_e.append($(`<option value='${index}'>${tag ? i18n.getMessage(tag) : title}</option>`));
            });
        }

        const buildTypes = [
            {
                tag: "firmwareFlasherOptionLabelBuildTypeRelease",
            },
            {
                tag: "firmwareFlasherOptionLabelBuildTypeReleaseCandidate",
            },
            {
                tag: "firmwareFlasherOptionLabelBuildTypeDevelopment",
            },
        ];

        function showOrHideBuildTypes() {
            const showExtraReleases = $(this).is(":checked");

            if (showExtraReleases) {
                $("tr.build_type").show();
            } else {
                $("tr.build_type").hide();
                buildType_e.val(0).trigger("change");
            }
        }

        function showOrHideExpertMode() {
            const expertModeChecked = $(this).is(":checked");

            if (expertModeChecked) {
                buildTypesToShow = buildTypes;
            } else {
                buildTypesToShow = buildTypes.slice(0, 2);
            }

            buildBuildTypeOptionsList();
            buildType_e.val(0).trigger("change");

            setTimeout(() => {
                $("tr.expertOptions").toggle(expertModeChecked);
                $("div.expertOptions").toggle(expertModeChecked);
            }, 0);

            setConfig({ expertMode: expertModeChecked });
        }

        const expertMode_e = $(".tab-firmware_flasher input.expert_mode");
        const expertMode = getConfig("expertMode").expertMode;

        expertMode_e.prop("checked", expertMode);
        expertMode_e.on("change", showOrHideExpertMode).trigger("change");

        $("input.show_development_releases").change(showOrHideBuildTypes).change();

        // translate to user-selected language
        i18n.localizePage();

        buildType_e.on("change", async function () {
            self.enableLoadRemoteFileButton(false);

            const build_type = buildType_e.val();

            $('select[name="board"]')
                .empty()
                .append($(`<option value='0'>${i18n.getMessage("firmwareFlasherOptionLoading")}</option>`));

            $('select[name="firmware_version"]')
                .empty()
                .append($(`<option value='0'>${i18n.getMessage("firmwareFlasherOptionLoading")}</option>`));

            if (!GUI.connect_lock) {
                try {
                    loadTargetList(await self.buildApi.loadTargets());
                } catch (err) {
                    console.error(err);
                }
            }

            setConfig({ selected_build_type: build_type });
        });

        async function selectFirmware(release) {
            $("div.build_configuration").slideUp();
            $("div.release_info").slideUp();

            if (!self.localFirmwareLoaded) {
                self.enableFlashButton(false);
                self.flashingMessage(
                    i18n.getMessage("firmwareFlasherLoadFirmwareFile"),
                    self.FLASH_MESSAGE_TYPES.NEUTRAL,
                );
                if (self.parsed_hex && self.parsed_hex.bytes_total) {
                    // Changing the board triggers a version change, so we need only dump it here.
                    console.log(`${self.logHead} throw out loaded hex`);
                    self.intel_hex = undefined;
                    self.parsed_hex = undefined;
                }
            }

            const target = $('select[name="board"] option:selected').val();

            async function LoadTargetDetail(detail) {
                if (!detail) {
                    self.enableLoadRemoteFileButton(false);
                    return;
                }

                self.targetDetail = detail;
                if (detail.cloudBuild === true) {
                    $("div.build_configuration").slideDown();

                    const expertMode = expertMode_e.is(":checked");
                    if (expertMode) {
                        if (detail.releaseType === "Unstable") {
                            let commits = await self.buildApi.loadCommits(detail.release);
                            if (commits) {
                                const select_e = $('select[name="commits"]');
                                select_e.empty();
                                commits.forEach((commit) => {
                                    select_e.append(
                                        $(`<option value='${commit.sha}'>${commit.message.split("\n")[0]}</option>`),
                                    );
                                });
                            }

                            $("div.commitSelection").show();
                        } else {
                            $("div.commitSelection").hide();
                        }
                    }

                    $("div.expertOptions").toggle(expertMode);
                    // Need to reset core build mode
                    $("input.corebuild_mode").trigger("change");
                }

                if (detail.configuration && !self.isConfigLocal) {
                    setBoardConfig(detail.configuration);
                }

                self.enableLoadRemoteFileButton(true);
            }

            try {
                let targetDetail = await self.buildApi.loadTarget(target, release);
                await LoadTargetDetail(targetDetail);
            } catch (error) {
                console.error("Failed to load target:", error);
                loadFailed();
                return;
            }

            try {
                if (self.validateBuildKey()) {
                    let options = await self.buildApi.loadOptionsByBuildKey(release, self.cloudBuildKey);
                    if (options) {
                        buildOptions(options);
                        return;
                    }
                }
                buildOptions(await self.buildApi.loadOptions(release));
            } catch (error) {
                console.error("Failed to load build options:", error);
                return;
            }
        }

        function populateReleases(versions_element, target) {
            const sortReleases = function (a, b) {
                return -semver.compareBuild(a.release, b.release);
            };

            versions_element.empty();
            const releases = target.releases;
            if (releases.length > 0) {
                versions_element.append(
                    $(
                        `<option value='0'>${i18n.getMessage("firmwareFlasherOptionLabelSelectFirmwareVersionFor")} ${
                            target.target
                        }</option>`,
                    ),
                );

                const build_type = $('select[name="build_type"]').val();

                releases
                    .sort(sortReleases)
                    .filter((r) => {
                        return (
                            (r.type === "Unstable" && build_type > 1) ||
                            (r.type === "ReleaseCandidate" && build_type > 0) ||
                            r.type === "Stable"
                        );
                    })
                    .forEach(function (release) {
                        const releaseName = release.release;

                        const select_e = $(`<option value='${releaseName}'>${releaseName} [${release.label}]</option>`);
                        const summary = `${target}/${release}`;
                        select_e.data("summary", summary);
                        versions_element.append(select_e);
                    });

                // Assume flashing latest, so default to it.
                versions_element.prop("selectedIndex", 1);
                selectFirmware(versions_element.val());
            }
        }

        function clearBufferedFirmware() {
            clearBoardConfig();
            self.intel_hex = undefined;
            self.parsed_hex = undefined;
            self.localFirmwareLoaded = false;
        }

        $('select[name="board"]').select2();
        $('select[name="osdProtocols"]').select2();
        $('select[name="radioProtocols"]').select2();
        $('select[name="telemetryProtocols"]').select2();
        $('select[name="motorProtocols"]').select2();
        $('select[name="options"]').select2({ tags: false, closeOnSelect: false });
        $('select[name="commits"]').select2({ tags: true });

        $('select[name="options"]')
            .on("select2:opening", function () {
                const searchfield = $(this).parent().find(".select2-search__field");
                searchfield.prop("disabled", false);
            })
            .on("select2:closing", function () {
                const searchfield = $(this).parent().find(".select2-search__field");
                searchfield.prop("disabled", true);
            });

        $('select[name="radioProtocols"]').on("select2:select", function () {
            const selectedProtocol = $('select[name="radioProtocols"] option:selected').first().val();
            if (selectedProtocol) {
                setConfig({ ffRadioProtocol: selectedProtocol });
            }

            toggleTelemetryProtocolInfo();
        });

        $('select[name="board"]').on("change", async function () {
            self.enableLoadRemoteFileButton(false);
            let target = $(this).val();

            // exception for board flashed with local custom firmware
            if (target === null) {
                target = "0";
                $(this).val(target).trigger("change");
            }

            if (!GUI.connect_lock) {
                self.selectedBoard = target;
                console.log(`${self.logHead} board changed to`, target);

                self.flashingMessage(
                    i18n.getMessage("firmwareFlasherLoadFirmwareFile"),
                    self.FLASH_MESSAGE_TYPES.NEUTRAL,
                ).flashProgress(0);

                $("div.release_info").slideUp();
                $("div.build_configuration").slideUp();

                if (!self.localFirmwareLoaded) {
                    self.enableFlashButton(false);
                }

                const versions_e = $('select[name="firmware_version"]');
                if (target === "0") {
                    // target is 0 is the "Choose a Board" option. Throw out anything loaded
                    clearBufferedFirmware();

                    versions_e.empty();
                    versions_e.append(
                        $(
                            `<option value='0'>${i18n.getMessage(
                                "firmwareFlasherOptionLabelSelectFirmwareVersion",
                            )}</option>`,
                        ),
                    );
                } else {
                    // Show a loading message as there is a delay in loading a configuration
                    versions_e.empty();
                    versions_e.append(
                        $(`<option value='0'>${i18n.getMessage("firmwareFlasherOptionLoading")}</option>`),
                    );

                    populateReleases(versions_e, await self.buildApi.loadTargetReleases(target));
                }
            }
        });
        // when any of the select2 elements is opened, force a focus on that element's search box
        const select2Elements = [
            'select[name="board"]',
            'select[name="radioProtocols"]',
            'select[name="telemetryProtocols"]',
            'select[name="osdProtocols"]',
            'select[name="motorProtocols"]',
            'select[name="options"]',
            'select[name="commits"]',
        ];

        $(document).on("select2:open", select2Elements.join(","), () => {
            const allFound = document.querySelectorAll(".select2-container--open .select2-search__field");
            $(this).one("mouseup keyup", () => {
                setTimeout(() => {
                    allFound[allFound.length - 1].focus();
                }, 0);
            });
        });

        function cleanUnifiedConfigFile(input) {
            let output = [];
            let inComment = false;
            for (let i = 0; i < input.length; i++) {
                if (input.charAt(i) === "\n" || input.charAt(i) === "\r") {
                    inComment = false;
                }

                if (input.charAt(i) === "#") {
                    inComment = true;
                }

                if (!inComment && input.charCodeAt(i) > 255) {
                    self.flashingMessage(
                        i18n.getMessage("firmwareFlasherConfigCorrupted"),
                        self.FLASH_MESSAGE_TYPES.INVALID,
                    );
                    gui_log(i18n.getMessage("firmwareFlasherConfigCorruptedLogMessage"));
                    return null;
                }

                if (input.charCodeAt(i) > 255) {
                    output.push("_");
                } else {
                    output.push(input.charAt(i));
                }
            }
            return output.join("").split("\n");
        }

        function detectedUsbDevice(device) {
            const isFlashOnConnect = $("input.flash_on_connect").is(":checked");

            console.log(`${self.logHead} Detected USB device:`, device);
            console.log(`${self.logHead} Reboot mode: %s, flash on connect`, STM32.rebootMode, isFlashOnConnect);

            if (STM32.rebootMode || isFlashOnConnect) {
                STM32.rebootMode = 0;
                GUI.connect_lock = false;
                startFlashing();
            }
        }

        EventBus.$on("port-handler:auto-select-usb-device", detectedUsbDevice);

        function flashFirmware(firmware) {
            const options = {};

            let eraseAll = false;
            if ($("input.erase_chip").is(":checked") || expertMode_e.is(":not(:checked)")) {
                options.erase_chip = true;

                eraseAll = true;
            }

            const port = PortHandler.portPicker.selectedPort;
            const isSerial = port.startsWith("serial");
            const isDFU = port.startsWith("usb");

            console.log(`${self.logHead} Selected port:`, port);

            if (isDFU) {
                tracking.sendEvent(tracking.EVENT_CATEGORIES.FLASHING, "DFU Flashing", {
                    filename: self.filename || null,
                });
                DFU.connect(port, firmware, options);
            } else if (isSerial) {
                if ($("input.updating").is(":checked")) {
                    options.no_reboot = true;
                } else {
                    options.reboot_baud = PortHandler.portPicker.selectedBauds;
                }

                let baud = 115200;
                if ($("input.flash_manual_baud").is(":checked")) {
                    baud = parseInt($("#flash_manual_baud_rate").val()) || 115200;
                }

                tracking.sendEvent(tracking.EVENT_CATEGORIES.FLASHING, "Flashing", { filename: self.filename || null });

                STM32.connect(port, baud, firmware, options);
            } else {
                // Maybe the board is in DFU mode, but it does not have permissions. Ask for them.
                console.log(`${self.logHead} No valid port detected, asking for permissions`);
                DFU.requestPermission().then((device) => {
                    DFU.connect(device.path, firmware, options);
                });
            }

            self.isFlashing = false;
        }

        let result = getConfig("erase_chip");
        $("input.erase_chip").prop("checked", result.erase_chip); // users can override this during the session

        $("input.erase_chip")
            .change(function () {
                setConfig({ erase_chip: $(this).is(":checked") });
            })
            .change();

        result = getConfig("show_development_releases");
        $("input.show_development_releases")
            .prop("checked", result.show_development_releases)
            .change(function () {
                setConfig({ show_development_releases: $(this).is(":checked") });
            })
            .change();

        result = getConfig("selected_build_type");
        // ensure default build type is selected
        buildType_e.val(result.selected_build_type || 0).trigger("change");

        result = getConfig("no_reboot_sequence");
        if (result.no_reboot_sequence) {
            $("input.updating").prop("checked", true);
            $(".flash_on_connect_wrapper").show();
        } else {
            $("input.updating").prop("checked", false);
        }

        // bind UI hook so the status is saved on change
        $("input.updating").change(function () {
            const status = $(this).is(":checked");

            if (status) {
                $(".flash_on_connect_wrapper").show();
            } else {
                $("input.flash_on_connect").prop("checked", false).change();
                $(".flash_on_connect_wrapper").hide();
            }

            setConfig({ no_reboot_sequence: status });
        });

        $("input.updating").change();

        result = getConfig("flash_manual_baud");
        if (result.flash_manual_baud) {
            $("input.flash_manual_baud").prop("checked", true);
        } else {
            $("input.flash_manual_baud").prop("checked", false);
        }

        $("input.corebuild_mode").change(function () {
            const status = $(this).is(":checked");

            $(".hide-in-core-build-mode").toggle(!status);
            $("div.expertOptions").toggle(!status && expertMode_e.is(":checked"));
        });
        $("input.corebuild_mode").change();

        // bind UI hook so the status is saved on change
        $("input.flash_manual_baud").change(function () {
            const status = $(this).is(":checked");
            setConfig({ flash_manual_baud: status });
        });

        $("input.flash_manual_baud").change();

        result = getConfig("flash_manual_baud_rate");
        $("#flash_manual_baud_rate").val(result.flash_manual_baud_rate);

        // bind UI hook so the status is saved on change
        $("#flash_manual_baud_rate").change(function () {
            const baud = parseInt($("#flash_manual_baud_rate").val());
            setConfig({ flash_manual_baud_rate: baud });
        });

        $("input.flash_manual_baud_rate").change();

        // UI Hooks
        $("a.load_file").on("click", function () {
            // Reset button when loading a new firmware
            self.enableFlashButton(false);
            self.enableLoadRemoteFileButton(false);

            self.developmentFirmwareLoaded = false;

            FileSystem.pickOpenFile(i18n.getMessage("fileSystemPickerFiles", { typeof: "HEX" }), ".hex")
                .then((file) => {
                    console.log(`${self.logHead} Saving firmware to:`, file.name);
                    FileSystem.readFile(file).then((data) => {
                        if (file.name.split(".").pop() === "hex") {
                            self.intel_hex = data;
                            parseHex(self.intel_hex, function (data) {
                                self.parsed_hex = data;

                                if (self.parsed_hex) {
                                    self.localFirmwareLoaded = true;

                                    showLoadedHex(file.name);
                                } else {
                                    self.flashingMessage(
                                        i18n.getMessage("firmwareFlasherHexCorrupted"),
                                        self.FLASH_MESSAGE_TYPES.INVALID,
                                    );
                                }
                            });
                        } else {
                            clearBufferedFirmware();

                            let config = cleanUnifiedConfigFile(data);
                            if (config !== null) {
                                setBoardConfig(config, file.name);

                                if (self.isConfigLocal && !self.parsed_hex) {
                                    self.flashingMessage(
                                        i18n.getMessage("firmwareFlasherLoadedConfig"),
                                        self.FLASH_MESSAGE_TYPES.NEUTRAL,
                                    );
                                }

                                if (
                                    (self.isConfigLocal && self.parsed_hex && !self.localFirmwareLoaded) ||
                                    self.localFirmwareLoaded
                                ) {
                                    self.enableFlashButton(true);
                                    self.flashingMessage(
                                        i18n.getMessage(
                                            "firmwareFlasherFirmwareLocalLoaded",
                                            self.parsed_hex.bytes_total,
                                        ),
                                        self.FLASH_MESSAGE_TYPES.NEUTRAL,
                                    );
                                }
                            }
                        }
                    });
                })
                .catch((error) => {
                    console.error("Error reading file:", error);
                    self.enableLoadRemoteFileButton(true);
                });
        });

        /**
         * Lock / Unlock the firmware download button according to the firmware selection dropdown.
         */
        $('select[name="firmware_version"]').change((evt) => {
            selectFirmware($("option:selected", evt.target).val());
        });

        $("a.cloud_build_cancel").on("click", function (evt) {
            $("a.cloud_build_cancel").toggleClass("disabled", true);
            self.cancelBuild = true;
        });

        async function enforceOSDSelection() {
            const firmwareVersion = $('select[name="firmware_version"] option:selected').text();

            // Skip OSD selection enforcement for firmware versions 4.3.x
            if (firmwareVersion.startsWith("4.3.")) {
                return true;
            }

            if ($('select[name="osdProtocols"] option:selected').val() === "") {
                return new Promise((resolve) => {
                    GUI.showYesNoDialog({
                        title: i18n.getMessage("firmwareFlasherOSDProtocolNotSelected"),
                        text: i18n.getMessage("firmwareFlasherOSDProtocolNotSelectedDescription"),
                        buttonYesText: i18n.getMessage("firmwareFlasherOSDProtocolNotSelectedContinue"),
                        buttonNoText: i18n.getMessage("firmwareFlasherOSDProtocolSelect"),
                        buttonYesCallback: () => resolve(true),
                        buttonNoCallback: () => resolve(false),
                    });
                });
            } else {
                return true; // No issue with OSD selection
            }
        }

        $("a.load_remote_file").on("click", async function (evt) {
            if (!self.selectedBoard) {
                return;
            }

            // Ensure the user has selected an OSD protocol
            const shouldContinue = await enforceOSDSelection();

            if (!shouldContinue) {
                return;
            }

            // Reset button when loading a new firmware
            self.enableFlashButton(false);
            self.enableLoadRemoteFileButton(false);

            self.localFirmwareLoaded = false;
            self.developmentFirmwareLoaded =
                buildTypesToShow[$('select[name="build_type"]').val()].tag ===
                "firmwareFlasherOptionLabelBuildTypeDevelopment";

            if ($('select[name="firmware_version"]').val() === "0") {
                gui_log(i18n.getMessage("firmwareFlasherNoFirmwareSelected"));
                return;
            }

            function updateStatus(status, key, val, showLog) {
                if (showLog === true) {
                    $("div.release_info #cloudTargetLog")
                        .text(i18n.getMessage(`firmwareFlasherCloudBuildLogUrl`))
                        .prop("href", `https://build.betaflight.com/api/builds/${key}/log`);
                }
                $("div.release_info #cloudTargetStatus").text(i18n.getMessage(`firmwareFlasherCloudBuild${status}`));
                $(".buildProgress").val(val);
            }

            async function processBuildSuccess(response, statusResponse, suffix) {
                if (statusResponse.status !== "success") {
                    return;
                }
                updateStatus(`Success${suffix}`, response.key, 100, true);
                if (statusResponse.configuration !== undefined && !self.isConfigLocal) {
                    setBoardConfig(statusResponse.configuration);
                }
                processHex(await self.buildApi.loadTargetHex(response.url), response.file);
            }

            async function requestCloudBuild(targetDetail) {
                let request = {
                    target: targetDetail.target,
                    release: targetDetail.release,
                    options: [],
                };

                const coreBuild =
                    targetDetail.cloudBuild !== true || $('input[name="coreBuildModeCheckbox"]').is(":checked");
                if (coreBuild === true) {
                    request.options.push("CORE_BUILD");
                } else {
                    request.options.push("CLOUD_BUILD");
                    $('select[name="radioProtocols"] option:selected').each(function () {
                        request.options.push($(this).val());
                    });

                    $('select[name="telemetryProtocols"] option:selected').each(function () {
                        request.options.push($(this).val());
                    });

                    $('select[name="options"] option:selected').each(function () {
                        request.options.push($(this).val());
                    });

                    $('select[name="osdProtocols"] option:selected').each(function () {
                        request.options.push($(this).val());
                    });

                    $('select[name="motorProtocols"] option:selected').each(function () {
                        request.options.push($(this).val());
                    });

                    if ($('input[name="expertModeCheckbox"]').is(":checked")) {
                        if (targetDetail.releaseType === "Unstable") {
                            request.commit = $('select[name="commits"] option:selected').val();
                        }

                        $('input[name="customDefines"]')
                            .val()
                            .split(" ")
                            .map((element) => element.trim())
                            .forEach((v) => {
                                request.options.push(v);
                            });
                    }
                }

                console.info("Build request:", request);
                let response = await self.buildApi.requestBuild(request);
                if (!response) {
                    updateStatus("FailRequest", "", 0, false);
                    loadFailed();
                    return;
                }

                console.info("Build response:", response);

                // Complete the summary object to be used later
                self.targetDetail.file = response.file;

                if (!targetDetail.cloudBuild) {
                    // it is a previous release, so simply load the hex
                    processHex(await self.buildApi.loadTargetHex(response.url), response.file);
                    return;
                }

                updateStatus("Pending", response.key, 0, false);
                self.cancelBuild = false;

                let statusResponse = await self.buildApi.requestBuildStatus(response.key);

                if (statusResponse.status === "success") {
                    // will be cached already, no need to wait.
                    await processBuildSuccess(response, statusResponse, "Cached");
                    return;
                }

                self.enableCancelBuildButton(true);
                const retrySeconds = 5;
                let retries = 1;
                let processing = false;
                let timeout = 120;
                const timer = setInterval(async () => {
                    retries++;
                    let statusResponse = await self.buildApi.requestBuildStatus(response.key);

                    if (!statusResponse) {
                        return;
                    }

                    if (statusResponse.timeOut !== undefined) {
                        if (!processing) {
                            processing = true;
                            retries = 1;
                        }
                        timeout = statusResponse.timeOut;
                    }
                    const retryTotal = timeout / retrySeconds;

                    if (statusResponse.status !== "queued" || retries > retryTotal || self.cancelBuild) {
                        self.enableCancelBuildButton(false);
                        clearInterval(timer);

                        if (statusResponse.status === "success") {
                            processBuildSuccess(response, statusResponse, "");
                            return;
                        }

                        let suffix = "";
                        if (retries > retryTotal) {
                            suffix = "TimeOut";
                        }

                        if (self.cancelBuild) {
                            suffix = "Cancel";
                        }
                        updateStatus(`Fail${suffix}`, response.key, 0, true);
                        loadFailed();
                        return;
                    }

                    if (processing) {
                        updateStatus("Processing", response.key, retries * (100 / retryTotal), false);
                    }
                }, retrySeconds * 1000);
            }

            if (self.targetDetail) {
                // undefined while list is loading or while running offline
                $("a.load_remote_file").text(i18n.getMessage("firmwareFlasherButtonDownloading"));
                self.enableLoadRemoteFileButton(false);

                showReleaseNotes(self.targetDetail);

                await requestCloudBuild(self.targetDetail);
            } else {
                $("span.progressLabel")
                    .attr("i18n", "firmwareFlasherFailedToLoadOnlineFirmware")
                    .removeClass("i18n-replaced");
                i18n.localizePage();
            }
        });

        const exitDfuElement = $("a.exit_dfu");

        exitDfuElement.on("click", function () {
            self.enableDfuExitButton(false);

            if (!GUI.connect_lock) {
                // button disabled while flashing is in progress
                try {
                    console.log(`${self.logHead} Closing DFU`);
                    DFU.requestPermission().then((device) => {
                        DFU.connect(device.path, self.parsed_hex, { exitDfu: true });
                    });
                } catch (e) {
                    console.log(`${self.logHead} Exiting DFU failed: ${e.message}`);
                }
            }
        });

        const targetSupportInfo = $("#targetSupportInfoUrl");

        targetSupportInfo.on("click", function () {
            let urlSupport = "https://betaflight.com/docs/wiki/boards/archive/Missing"; // general board missing
            const urlBoard = `https://betaflight.com/docs/wiki/boards/current/${self.selectedBoard}`; // board description
            if (urlExists(urlBoard)) {
                urlSupport = urlBoard;
            }
            targetSupportInfo.attr("href", urlSupport);
        });

        const detectBoardElement = $("a.detect-board");

        detectBoardElement.on("click", () => {
            detectBoardElement.toggleClass("disabled", true);

            /**
             *
             *    Auto-detect board and set the dropdown to the correct value
             */

            if (!GUI.connect_lock) {
                AutoDetect.verifyBoard(PortHandler.portPicker.selectedPort);
            }

            // prevent spamming the button
            setTimeout(() => detectBoardElement.toggleClass("disabled", false), 2000);
        });

        function initiateFlashing() {
            if (self.developmentFirmwareLoaded) {
                checkShowAcknowledgementDialog();
            } else {
                startFlashing();
            }
        }

        // Backup not available in DFU, manual, virtual mode or when using flash on connect

        function startBackup(callback) {
            // prevent connection while backup is in progress
            GUI.connect_lock = true;

            const aborted = function (message) {
                GUI.connect_lock = false;
                self.isFlashing = false;
                self.enableFlashButton(true);
                self.enableLoadRemoteFileButton(true);
                self.enableLoadFileButton(true);

                self.flashingMessage(i18n.getMessage(message), self.FLASH_MESSAGE_TYPES.INVALID);
            };

            const callBackWhenPortAvailable = function () {
                const startTime = Date.now();
                const interval = setInterval(() => {
                    if (PortHandler.portAvailable) {
                        clearInterval(interval);
                        callback();
                    } else if (Date.now() - startTime > 5000) {
                        clearInterval(interval);
                        // failed to connect
                        aborted("portsSelectNone");
                    }
                }, 100);
            };

            AutoBackup.execute((result) => {
                GUI.connect_lock = false;
                if (result) {
                    // wait for the port to be available again - timeout after 5 seconds
                    callBackWhenPortAvailable();
                } else {
                    aborted("firmwareFlasherCanceledBackup");
                }
            });
        }

        function checkShowAcknowledgementDialog() {
            const DAY_MS = 86400 * 1000;
            const storageTag = "lastDevelopmentWarningTimestamp";

            function setAcknowledgementTimestamp() {
                const storageObj = {};
                storageObj[storageTag] = Date.now();
                setStorage(storageObj);
            }

            result = getStorage(storageTag);
            if (!result[storageTag] || Date.now() - result[storageTag] > DAY_MS) {
                showAcknowledgementDialog(setAcknowledgementTimestamp);
            } else {
                startFlashing();
            }
        }

        function showAcknowledgementDialog(acknowledgementCallback) {
            const dialog = $("#dialogUnstableFirmwareAcknowledgement")[0];
            const flashButtonElement = $("#dialogUnstableFirmwareAcknowledgement-flashbtn");
            const acknowledgeCheckboxElement = $('input[name="dialogUnstableFirmwareAcknowledgement-acknowledge"]');

            acknowledgeCheckboxElement.change(function () {
                if ($(this).is(":checked")) {
                    flashButtonElement.removeClass("disabled");
                } else {
                    flashButtonElement.addClass("disabled");
                }
            });

            flashButtonElement.click(function () {
                dialog.close();

                if (acknowledgeCheckboxElement.is(":checked")) {
                    if (acknowledgementCallback) {
                        acknowledgementCallback();
                    }

                    startFlashing();
                }
            });

            $("#dialogUnstableFirmwareAcknowledgement-cancelbtn").click(function () {
                dialog.close();
            });

            dialog.addEventListener("close", function () {
                acknowledgeCheckboxElement.prop("checked", false).change();
            });

            dialog.showModal();
        }

        function startFlashing() {
            if (!GUI.connect_lock) {
                // button disabled while flashing is in progress
                if (self.parsed_hex) {
                    try {
                        if (self.config && !self.parsed_hex.configInserted) {
                            const configInserter = new ConfigInserter();

                            if (configInserter.insertConfig(self.parsed_hex, self.config)) {
                                self.parsed_hex.configInserted = true;
                            } else {
                                console.log(`${self.logHead} Firmware does not support custom defaults.`);
                                clearBoardConfig();
                            }
                        }

                        flashFirmware(self.parsed_hex);
                    } catch (e) {
                        console.log(`${self.logHead} Flashing failed: ${e.message}`);
                    }
                    // Disable flash on connect after flashing to prevent continuous flashing
                    $("input.flash_on_connect").prop("checked", false).change();
                } else {
                    $("span.progressLabel")
                        .attr("i18n", "firmwareFlasherFirmwareNotLoaded")
                        .removeClass("i18n-replaced");
                    i18n.localizePage();
                }
            }
        }

        $("a.flash_firmware").on("click", function () {
            if (GUI.connect_lock) {
                return;
            }

            // Check if we're in ELRS mode
            if ($('select[name="firmware_type"]').val() === "elrs") {
                // Check if we have all required data
                if (!self.store.target || !self.store.options.flashMethod) {
                    alert("Please select a target and flash method first.");
                    return;
                }

                // Handle different flash methods
                if (self.store.options.flashMethod === "download") {
                    // Handle local download
                    self.downloadELRSFirmware();
                } else {
                    // Handle device flashing
                    self.handleELRSDeviceFlashing();
                }
                return;
            }

            // Original Betaflight firmware handling
            self.isFlashing = true;

            self.enableFlashButton(false);
            self.enableDfuExitButton(false);
            self.enableLoadRemoteFileButton(false);
            self.enableLoadFileButton(false);

            const isFlashOnConnect = $("input.flash_on_connect").is(":checked");

            if (isFlashOnConnect || !PortHandler.portAvailable) {
                startFlashing();
                return;
            }

            // backupOnFlash:
            // 0: disabled (default)
            // 1: backup without dialog
            // 2: backup with dialog

            const backupOnFlash = getConfig("backupOnFlash", 1).backupOnFlash;

            switch (backupOnFlash) {
                case 1:
                    // prevent connection while backup is in progress
                    startBackup(initiateFlashing);
                    break;
                case 2:
                    GUI.showYesNoDialog({
                        title: i18n.getMessage("firmwareFlasherRemindBackupTitle"),
                        text: i18n.getMessage("firmwareFlasherRemindBackup"),
                        buttonYesText: i18n.getMessage("firmwareFlasherBackup"),
                        buttonNoText: i18n.getMessage("firmwareFlasherBackupIgnore"),
                        buttonYesCallback: () => {
                            startBackup(initiateFlashing);
                        },
                        buttonNoCallback: initiateFlashing,
                    });
                    break;
                default:
                    initiateFlashing();
                    break;
            }
        });

        $("span.progressLabel").on("click", "a.save_firmware", function () {
            FileSystem.pickSaveFile(
                self.targetDetail.file,
                i18n.getMessage("fileSystemPickerFiles", { typeof: "HEX" }),
                ".hex",
            )
                .then((file) => {
                    console.log(`${self.logHead} Saving firmware to:`, file.name);
                    FileSystem.writeFile(file, self.intel_hex);
                })
                .catch((error) => {
                    console.error("Error saving file:", error);
                });
        });

        self.flashingMessage(i18n.getMessage("firmwareFlasherLoadFirmwareFile"), self.FLASH_MESSAGE_TYPES.NEUTRAL);

        if (PortHandler.dfuAvailable) {
            $("a.exit_dfu").removeClass("disabled");
        }

        GUI.content_ready(callback);
    }

    console.log(`${self.logHead} Targets loaded`);
    $("#content").load("./tabs/firmware_flasher.html", onDocumentLoad);
};

// Helper functions

firmware_flasher.validateBuildKey = function () {
    return this.cloudBuildKey?.length === 32 && ispConnected();
};

firmware_flasher.cleanup = function (callback) {
    // unbind "global" events
    $(document).unbind("keypress");
    $(document).off("click", "span.progressLabel a");

    if (callback) callback();
};

firmware_flasher.enableCancelBuildButton = function (enabled) {
    $("a.cloud_build_cancel").toggleClass("disabled", !enabled);
    self.cancelBuild = false; // remove the semaphore
};

firmware_flasher.enableFlashButton = function (enabled) {
    $("a.flash_firmware").toggleClass("disabled", !enabled);
};

// ELRS Flasher Functions
firmware_flasher.initializeELRSFlasher = function () {
    // Initialize with default values
    this.store.firmware = "firmware"; // Default firmware type
    this.store.targetType = "rx"; // Default target type

    // Initialize the UI - only populate firmware versions initially
    this.populateELRSFirmwareVersions();
    this.populateELRSVendors();
    this.populateELRSRadios();
    this.populateELRSTargets();
    this.populateELRSFlashMethods();
    this.populateELRSRegulatoryDomains();

    // Set up event handlers
    this.setupELRSEventHandlers();
    this.setupELRSBindPhraseInput();
    const updateWiFiVisibility = this.setupELRSWiFiSettings();

    // Store the update function for later use
    window.updateWiFiVisibility = updateWiFiVisibility;
};

firmware_flasher.resetELRSState = function () {
    // Reset ELRS state variables
    this.firmware = null;
    this.flashBranch = false;
    this.hardware = null;
    this.versions = [];
    this.vendors = [];
    this.radios = [];
    this.targets = [];
    this.luaUrl = null;

    // Reset store
    this.store = {
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
                rxAsTxType: 0,
            },
        },
    };

    // Reset flashing state
    this.step = 1;
    this.enableFlash = false;
    this.allowErase = true;
    this.fullErase = false;
    this.flashComplete = false;
    this.failed = false;
    this.log = [];
    this.newline = false;
    this.noDevice = false;
    this.flasher = null;
    this.device = null;
    this.progress = 0;
    this.progressText = "";

    // Reset files
    this.files = {
        firmwareFiles: [],
        config: null,
        firmwareUrl: "",
        options: {},
        deviceType: null,
        radioType: undefined,
        txType: undefined,
    };
};

firmware_flasher.updateELRSVersions = function () {
    if (this.firmware) {
        this.hardware = null;
        this.store.version = null;
        this.versions = [];
        if (this.flashBranch) {
            Object.entries(this.firmware.branches).forEach(([key, value]) => {
                this.versions.push({ title: key, value: value });
                if (!this.store.version) this.store.version = value;
            });
            Object.entries(this.firmware.tags).forEach(([key, value]) => {
                if (key.indexOf("-") !== -1) this.versions.push({ title: key, value: value });
            });
            this.versions = this.versions.sort((a, b) => a.title.localeCompare(b.title));
        } else {
            let first = true;
            Object.keys(this.firmware.tags)
                .sort(compareSemanticVersions)
                .reverse()
                .forEach((key) => {
                    if (key.indexOf("-") === -1 || first) {
                        this.versions.push({ title: key, value: this.firmware.tags[key] });
                        if (!this.store.version && key.indexOf("-") === -1)
                            this.store.version = this.firmware.tags[key];
                        first = false;
                    }
                });
        }
        this.updateELRSVendors();
    }
};

firmware_flasher.populateELRSFirmwareVersions = function () {
    const select = $('select[name="elrs_firmware_version"]');
    select.empty();
    select.append('<option value="">Loading...</option>');

    // Load firmware data from local assets
    fetch(`./assets/${this.store.firmware}/index.json`)
        .then((r) => r.json())
        .then((r) => {
            this.firmware = r;
            this.updateELRSVersions();

            select.empty();
            this.versions.forEach((version) => {
                select.append(`<option value="${version.value}">${version.title}</option>`);
            });
        })
        .catch((error) => {
            console.error("Error loading firmware versions:", error);
            select.empty();
            select.append('<option value="">Error loading versions</option>');
        });
};

firmware_flasher.updateELRSVendors = function () {
    if (this.store.version) {
        this.store.folder = `./assets/${this.store.firmware}`;

        fetch(`./assets/${this.store.firmware}/hardware/targets.json`)
            .then((r) => r.json())
            .then((r) => {
                this.hardware = r;
                this.store.vendor = null;
                this.vendors = [];
                for (const [k, v] of Object.entries(this.hardware)) {
                    let hasTargets = false;
                    Object.keys(v).forEach((type) => (hasTargets |= type.startsWith(this.store.targetType)));
                    if (hasTargets && v.name) this.vendors.push({ title: v.name, value: k });
                }
                this.vendors.sort((a, b) => a.title.localeCompare(b.title));

                // Try to set default vendor if available
                const defaultVendor = "hdzero";
                if (this.vendors.some((v) => v.value === defaultVendor)) {
                    this.store.vendor = defaultVendor;
                }

                // Update the UI
                this.populateELRSVendors();
                this.updateELRSRadios();
            })
            .catch((_ignore) => {
                // Handle error silently
                this.vendors = [];
                this.populateELRSVendors();
            });
    } else {
        this.vendors = [];
        this.populateELRSVendors();
    }
};

firmware_flasher.populateELRSVendors = function () {
    const select = $('select[name="hardware-vendor"]');
    select.empty();

    if (this.vendors.length === 0) {
        select.append('<option value="">Select firmware version first</option>');
    } else {
        select.append('<option value="">Select vendor...</option>');
        this.vendors.forEach((vendor) => {
            select.append(`<option value="${vendor.value}">${vendor.title}</option>`);
        });

        // Set the selected value if we have a default vendor
        if (this.store.vendor) {
            select.val(this.store.vendor);
        }
    }
};

firmware_flasher.updateELRSRadios = function () {
    this.radios = [];
    let keepTarget = false;
    if (this.store.vendor && this.hardware) {
        Object.keys(this.hardware[this.store.vendor]).forEach((k) => {
            if (k.startsWith(this.store.targetType)) this.radios.push({ title: radioTitles[k], value: k });
            if (this.store.target && this.store.target.vendor === this.store.vendor && this.store.target.radio === k)
                keepTarget = true;
        });
        if (this.radios.length === 1) {
            this.store.radio = this.radios[0].value;
            keepTarget = true;
        }
    }
    if (!keepTarget) this.store.radio = null;

    // Update the UI
    this.populateELRSRadios();
    this.updateELRSTargets();
};

firmware_flasher.populateELRSRadios = function () {
    const select = $('select[name="radio-frequency"]');
    select.empty();

    if (this.radios.length === 0) {
        select.append('<option value="">Select vendor first</option>');
    } else {
        select.append('<option value="">Select radio type...</option>');
        this.radios.forEach((radio) => {
            select.append(`<option value="${radio.value}">${radio.title}</option>`);
        });
    }
};

firmware_flasher.updateELRSTargets = function () {
    this.targets = [];
    let keepTarget = false;
    if (this.store.version && this.hardware) {
        const version = this.versions.find((x) => x.value === this.store.version).title;
        for (const [vk, v] of Object.entries(this.hardware)) {
            if (vk === this.store.vendor || this.store.vendor === null) {
                for (const [rk, r] of Object.entries(v)) {
                    if (
                        rk.startsWith(this.store.targetType) &&
                        (rk === this.store.radio || this.store.radio === null)
                    ) {
                        for (const [ck, c] of Object.entries(r)) {
                            if (this.flashBranch || compareSemanticVersions(version, c.min_version) >= 0) {
                                this.targets.push({
                                    title: c.product_name,
                                    value: { vendor: vk, radio: rk, target: ck, config: c },
                                });
                                if (
                                    this.store.target &&
                                    this.store.target.vendor === vk &&
                                    this.store.target.radio === rk &&
                                    this.store.target.target === ck
                                )
                                    keepTarget = true;
                            }
                        }
                    }
                }
            }
        }
    }
    this.targets.sort((a, b) => a.title.localeCompare(b.title));
    if (!keepTarget) this.store.target = null;

    // Update the UI
    this.populateELRSTargets();
    this.updateELRSLuaUrl();
};

firmware_flasher.populateELRSTargets = function () {
    const select = $('select[name="hardware-target"]');
    select.empty();

    if (this.targets.length === 0) {
        select.append('<option value="">Select radio type first</option>');
    } else {
        select.append('<option value="">Select hardware target...</option>');
        this.targets.forEach((target) => {
            select.append(`<option value="${target.value.target}">${target.title}</option>`);
        });
    }
};

firmware_flasher.updateELRSLuaUrl = function () {
    this.luaUrl = this.store.version ? `./assets/${this.store.firmware}/${this.store.version}/lua/elrsV3.lua` : null;
};

firmware_flasher.populateELRSFlashMethods = function () {
    const select = $('select[name="flashing-method"]');
    select.empty();
    select.append('<option value="">Select flashing method...</option>');

    // Get available methods from target configuration
    const availableMethods = this.store.target?.config?.upload_methods || [];
    const methods = getFlashMethods(availableMethods);

    methods.forEach((method) => {
        select.append(`<option value="${method.value}">${method.title}</option>`);
    });

    // Set default value if available
    if (methods.length > 0) {
        select.val("download");
        this.store.options.flashMethod = "download";
    }
};

firmware_flasher.hasHighFrequency = function () {
    return this.store.radio && (this.store.radio.endsWith("2400") || this.store.radio.endsWith("dual"));
};

firmware_flasher.hasLowFrequency = function () {
    return this.store.radio && (this.store.radio.endsWith("900") || this.store.radio.endsWith("dual"));
};

firmware_flasher.populateELRSRegulatoryDomains = function () {
    const regionSelect = $('select[name="region"]');
    const domainSelect = $('select[name="domain"]');

    // Clear existing options
    regionSelect.empty();
    domainSelect.empty();

    // Add region options if high frequency
    if (this.hasHighFrequency()) {
        regionSelect.append('<option value="">Select region...</option>');
        const regions = [
            { value: "FCC", title: "FCC" },
            { value: "LBT", title: "LBT" },
        ];
        regions.forEach((region) => {
            regionSelect.append(`<option value="${region.value}">${region.title}</option>`);
        });
        regionSelect.val(this.store.options.region);
        regionSelect.closest("tr").show();
    } else {
        regionSelect.closest("tr").hide();
    }

    // Add domain options if low frequency
    if (this.hasLowFrequency()) {
        domainSelect.append('<option value="">Select regulatory domain...</option>');
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
        domains.forEach((domain) => {
            domainSelect.append(`<option value="${domain.value}">${domain.title}</option>`);
        });
        domainSelect.val(this.store.options.domain);
        domainSelect.closest("tr").show();
    } else {
        domainSelect.closest("tr").hide();
    }
};

firmware_flasher.setupELRSEventHandlers = function () {
    // Firmware version change
    $('select[name="elrs_firmware_version"]').on("change", function () {
        firmware_flasher.store.version = $(this).val();
        firmware_flasher.updateELRSVendors();
    });

    // Vendor change
    $('select[name="hardware-vendor"]').on("change", function () {
        firmware_flasher.store.vendor = $(this).val();
        firmware_flasher.updateELRSRadios();
    });

    // Radio change
    $('select[name="radio-frequency"]').on("change", function () {
        firmware_flasher.store.radio = $(this).val();
        firmware_flasher.updateELRSTargets();
    });

    // Target change
    $('select[name="hardware-target"]').on("change", function () {
        const targetValue = $(this).val();
        firmware_flasher.store.target =
            firmware_flasher.targets.find((t) => t.value.target === targetValue)?.value || null;
        if (firmware_flasher.store.target) {
            firmware_flasher.store.vendor = firmware_flasher.store.target.vendor;
            firmware_flasher.store.radio = firmware_flasher.store.target.radio;

            // Update flash methods based on target capabilities
            firmware_flasher.populateELRSFlashMethods();

            // Update regulatory domains based on radio type
            firmware_flasher.populateELRSRegulatoryDomains();

            // Update WiFi settings visibility
            if (window.updateWiFiVisibility) {
                window.updateWiFiVisibility();
            }

            // Update button state - enable when target is selected
            firmware_flasher.updateELRSFlashButton();
        } else {
            // If no target selected, reset flash methods
            firmware_flasher.populateELRSFlashMethods();

            // Update regulatory domains
            firmware_flasher.populateELRSRegulatoryDomains();

            // Update WiFi settings visibility
            if (window.updateWiFiVisibility) {
                window.updateWiFiVisibility();
            }

            // Update button state - disable when no target
            firmware_flasher.updateELRSFlashButton();
        }
    });

    // Flash method change
    $('select[name="flashing-method"]').on("change", function () {
        const selectedMethod = $(this).val();
        firmware_flasher.store.options.flashMethod = selectedMethod;
        firmware_flasher.updateELRSFlashButton();
    });

    // Region change
    $('select[name="region"]').on("change", function () {
        const selectedRegion = $(this).val();
        firmware_flasher.store.options.region = selectedRegion;
    });

    // Domain change
    $('select[name="domain"]').on("change", function () {
        const selectedDomain = parseInt($(this).val());
        firmware_flasher.store.options.domain = selectedDomain;
    });

    // Connect device button
    $(".connect_device").on("click", function (e) {
        e.preventDefault();
        firmware_flasher.handleELRSDeviceFlashing();
    });

    // Flashing interface event handlers
    $(".flash_button").on("click", function () {
        firmware_flasher.fullErase = $('input[name="full_erase"]').is(":checked");
        firmware_flasher.flashELRSFirmware();
    });

    $(".flash_anyway_button").on("click", function () {
        firmware_flasher.fullErase = $('input[name="full_erase"]').is(":checked");
        firmware_flasher.flashELRSFirmware();
    });

    $(".try_again_button").on("click", function () {
        firmware_flasher.closeELRSDevice();
    });

    $(".flash_another_button").on("click", function () {
        firmware_flasher.elrsAnother();
    });

    $(".back_to_start_button").on("click", function () {
        firmware_flasher.elrsReset();
    });
};

firmware_flasher.generateUID = function (bindPhrase) {
    if (!bindPhrase || bindPhrase === "") {
        this.store.options.uid = null;
        return "Bind Phrase";
    } else {
        try {
            const uidBytes = uidBytesFromText(bindPhrase);
            const uidHex = Array.from(uidBytes)
                .map((b) => b.toString(16).padStart(2, "0"))
                .join("");
            this.store.options.uid = uidBytes;
            return `UID: ${uidHex}`;
        } catch (error) {
            console.error("Error generating UID:", error);
            this.store.options.uid = null;
            return "Bind Phrase";
        }
    }
};

firmware_flasher.setupELRSBindPhraseInput = function () {
    const input = $('input[name="bind-phrase"]');
    const label = input.attr("placeholder") || "Bind Phrase";

    // Set initial placeholder
    input.attr("placeholder", label);

    // Handle input changes
    input.on("input", function () {
        const bindPhrase = $(this).val();
        const uidLabel = firmware_flasher.generateUID(bindPhrase);

        // Update the placeholder to show the UID
        if (uidLabel.startsWith("UID: ")) {
            $(this).attr("placeholder", uidLabel);
        } else {
            $(this).attr("placeholder", label);
        }
    });
};

firmware_flasher.setupELRSWiFiSettings = function () {
    const ssidInput = $('input[name="wifi-ssid"]');
    const passwordInput = $('input[name="wifi-password"]');

    // Check if WiFi settings should be shown (not for STM32 platforms)
    function updateWiFiVisibility() {
        const shouldShow =
            firmware_flasher.store.target &&
            firmware_flasher.store.target.config &&
            firmware_flasher.store.target.config.platform !== "stm32";
        const wifiRow = ssidInput.closest("tr");

        if (shouldShow) {
            wifiRow.show();
        } else {
            wifiRow.hide();
            // Clear values when hidden
            firmware_flasher.store.options.ssid = null;
            firmware_flasher.store.options.password = null;
            ssidInput.val("");
            passwordInput.val("");
        }
    }

    // Handle SSID input changes
    ssidInput.on("input", function () {
        firmware_flasher.store.options.ssid = $(this).val() || null;
    });

    // Handle password input changes
    passwordInput.on("input", function () {
        firmware_flasher.store.options.password = $(this).val() || null;
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
};

firmware_flasher.updateELRSFlashButton = function () {
    const button = $(".flash_firmware");

    // Check if we have required data - only need target for download
    const hasTarget = this.store.target && this.store.target.config;

    if (hasTarget) {
        button.removeClass("disabled");

        // Update button text based on flash method
        if (this.store.options.flashMethod === "download") {
            button.text("Local download");
        } else {
            button.text("Flash Firmware");
        }
    } else {
        button.addClass("disabled");
        button.text("Flash Firmware");
    }
};

firmware_flasher.downloadELRSFirmware = function () {
    try {
        // Build firmware first
        this.buildELRSFirmware()
            .then(() => {
                try {
                    let data, filename;

                    if (this.store.target.config.platform === "esp8285") {
                        // For ESP8285, create gzipped firmware
                        // Note: In a real implementation, you'd use pako.gzip here
                        const bin = this.files.firmwareFiles[this.files.firmwareFiles.length - 1].data;
                        data = new Blob([bin], { type: "application/octet-stream" });
                        filename = "firmware.bin.gz";
                    } else if (
                        this.store.target.config.upload_methods &&
                        this.store.target.config.upload_methods.includes("zip")
                    ) {
                        // For ZIP upload method, create a ZIP file
                        // Note: In a real implementation, you'd use zip.js here
                        const bin = this.files.firmwareFiles[this.files.firmwareFiles.length - 1].data;
                        data = new Blob([bin], { type: "application/octet-stream" });
                        filename = "firmware.zip";
                    } else {
                        // Standard binary firmware
                        const bin = this.files.firmwareFiles[this.files.firmwareFiles.length - 1].data;
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
                    alert(`Error downloading firmware: ${error.message}`);
                }
            })
            .catch((error) => {
                alert(`Error building firmware: ${error.message}`);
            });
    } catch (error) {
        alert(`Error building firmware: ${error.message}`);
    }
};

firmware_flasher.handleELRSDeviceFlashing = function () {
    // Build firmware and connect to device
    this.buildELRSFirmware()
        .then(() => {
            this.connectELRSDevice();
        })
        .catch((error) => {
            alert(`Error building firmware: ${error.message}`);
        });
};

firmware_flasher.buildELRSFirmware = async function () {
    // Validate that we have all required data
    if (!this.store.target) {
        throw new Error("No target selected. Please select a hardware target first.");
    }

    if (!this.store.target.config) {
        throw new Error("Target configuration is missing. Please select a valid target.");
    }

    if (!this.store.options.flashMethod) {
        throw new Error("No flash method selected. Please select a flashing method.");
    }

    // Set currentStep to 3 to indicate we're ready to build firmware
    this.store.currentStep = 3;

    // Sync our store with the ELRS web flasher's store
    this.syncELRSStoreWithELRS();

    try {
        // Debug: Log the current store state
        console.log("Current store state:", {
            target: this.store.target,
            targetType: this.store.targetType,
            firmware: this.store.firmware,
            version: this.store.version,
            radio: this.store.radio,
            options: this.store.options,
        });

        const [binary, { config, firmwareUrl, options, deviceType, radioType, txType }] = await generateFirmware();

        this.files.firmwareFiles = binary;
        this.files.firmwareUrl = firmwareUrl;
        this.files.config = config;
        this.files.options = options;
        this.files.deviceType = deviceType;
        this.files.radioType = radioType;
        this.files.txType = txType;

        this.fullErase = false;
        this.allowErase = !(
            this.store.target.config.platform.startsWith("esp32") && this.store.options.flashMethod === "betaflight"
        );
    } catch (error) {
        console.error("Error building firmware:", error);
        throw error; // Re-throw to let calling function handle it
    }
};

firmware_flasher.syncELRSStoreWithELRS = function () {
    // Sync our store data with the ELRS web flasher's store
    elrsStore.currentStep = this.store.currentStep;
    elrsStore.firmware = this.store.firmware;
    elrsStore.folder = this.store.folder;
    elrsStore.targetType = this.store.targetType;
    elrsStore.version = this.store.version;
    elrsStore.vendor = this.store.vendor;
    elrsStore.vendor_name = this.store.vendor_name;
    elrsStore.radio = this.store.radio;
    elrsStore.target = this.store.target;
    elrsStore.name = this.store.name;

    // Sync options
    elrsStore.options.uid = this.store.options.uid;
    elrsStore.options.region = this.store.options.region;
    elrsStore.options.domain = this.store.options.domain;
    elrsStore.options.ssid = this.store.options.ssid;
    elrsStore.options.password = this.store.options.password;
    elrsStore.options.wifiOnInternal = this.store.options.wifiOnInternal;
    elrsStore.options.flashMethod = this.store.options.flashMethod;

    // Sync TX options
    elrsStore.options.tx.telemetryInterval = this.store.options.tx.telemetryInterval;
    elrsStore.options.tx.uartInverted = this.store.options.tx.uartInverted;
    elrsStore.options.tx.fanMinRuntime = this.store.options.tx.fanMinRuntime;
    elrsStore.options.tx.higherPower = this.store.options.tx.higherPower;
    elrsStore.options.tx.melodyType = this.store.options.tx.melodyType;
    elrsStore.options.tx.melodyTune = this.store.options.tx.melodyTune;

    // Sync RX options
    elrsStore.options.rx.uartBaud = this.store.options.rx.uartBaud;
    elrsStore.options.rx.lockOnFirstConnect = this.store.options.rx.lockOnFirstConnect;
    elrsStore.options.rx.r9mmMiniSBUS = this.store.options.rx.r9mmMiniSBUS;
    elrsStore.options.rx.fanMinRuntime = this.store.options.rx.fanMinRuntime;
    elrsStore.options.rx.rxAsTx = this.store.options.rx.rxAsTx;
    elrsStore.options.rx.rxAsTxType = this.store.options.rx.rxAsTxType;
};

firmware_flasher.connectELRSDevice = async function () {
    try {
        this.device = await navigator.serial.requestPort();
        this.device.ondisconnect = async (_p, _e) => {
            console.log("disconnected");
            await this.closeELRSDevice();
        };
    } catch {
        await this.closeELRSDevice();
        this.noDevice = true;
        this.updateELRSNoDeviceSnackbar();
        return;
    }

    if (this.device) {
        this.step++;
        this.updateELRSFlashingUI();

        const method = this.store.options.flashMethod;
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

        if (this.store.target.config.platform === "stm32") {
            this.flasher = new XmodemFlasher(
                this.device,
                this.files.deviceType,
                method,
                this.files.config,
                this.files.options,
                this.files.firmwareUrl,
                term,
            );
        } else {
            this.flasher = new ESPFlasher(
                this.device,
                this.files.deviceType,
                method,
                this.files.config,
                this.files.options,
                this.files.firmwareUrl,
                term,
            );
        }

        try {
            await this.flasher.connect();
            this.enableFlash = true;
            this.updateELRSFlashingUI();
        } catch (e) {
            if (e instanceof MismatchError) {
                term.writeln("Target mismatch, flashing cancelled");
                this.failed = true;
                this.enableFlash = true;
            } else if (e instanceof WrongMCU) {
                term.writeln(e.message);
                this.failed = true;
            } else {
                console.log(e);
                term.writeln("Failed to connect to device, restart device and try again");
                this.failed = true;
            }
            this.updateELRSFlashingUI();
        }
    }
};

firmware_flasher.closeELRSDevice = async function () {
    if (this.flasher) {
        try {
            await this.flasher.close();
        } catch (error) {
            // Ignore errors on close
        }
        this.flasher = null;
        this.device = null;
    }
    if (this.device != null) {
        try {
            await this.device.close();
        } catch (error) {
            // Ignore errors on close
        }
    }
    this.device = null;
    this.enableFlash = false;
    this.flashComplete = false;
    this.failed = false;
    this.step = 1;
    this.log = [];
    this.progress = 0;

    this.updateELRSFlashingUI();
};

firmware_flasher.updateELRSFlashingUI = function () {
    // Show/hide flashing interface
    const flashingInterface = $(".elrs_flashing_interface");
    const mainInterface = $(".elrs_firmware_content");

    if (this.step > 1) {
        flashingInterface.show();
        mainInterface.hide();
    } else {
        flashingInterface.hide();
        mainInterface.show();
    }

    // Update step visibility
    $(".step").hide();
    $(`.step[data-step="${this.step}"]`).show();

    // Update step-specific content
    if (this.step === 1) {
        $(".connect_device").show();
    } else if (this.step === 2) {
        // Show flash options if enabled
        if (this.enableFlash) {
            $(".flash_options").show();
            if (this.allowErase) {
                $('input[name="full_erase"]').show();
            } else {
                $('input[name="full_erase"]').hide();
            }

            if (!this.failed) {
                $(".flash_button").show();
            } else {
                $(".flash_anyway_button").show();
            }
            $(".try_again_button").show();
        }
    } else if (this.step === 3) {
        // Update the existing progress bar in the toolbar
        $(".content_toolbar .progress").val(this.progress);
        $(".content_toolbar .progressLabel").text(this.progressText || "Erasing flash, please wait...");

        if (this.failed) {
            $(".flash_failed").show();
        }
    } else if (this.step === 4) {
        // Done step - buttons are already in HTML
    }
};

firmware_flasher.updateELRSNoDeviceSnackbar = function () {
    if (this.noDevice) {
        $(".no_device_snackbar").show();
        setTimeout(() => {
            $(".no_device_snackbar").hide();
            this.noDevice = false;
        }, 5000);
    }
};

firmware_flasher.elrsAnother = async function () {
    await this.closeELRSDevice();
    await this.connectELRSDevice();
};

firmware_flasher.elrsReset = async function () {
    await this.closeELRSDevice();
    resetState();
};

firmware_flasher.enableLoadRemoteFileButton = function (enabled) {
    $("a.load_remote_file").toggleClass("disabled", !enabled);
};

firmware_flasher.enableLoadFileButton = function (enabled) {
    $("a.load_file").toggleClass("disabled", !enabled);
};

firmware_flasher.enableDfuExitButton = function (enabled) {
    $("a.exit_dfu").toggleClass("disabled", !enabled);
};

firmware_flasher.refresh = function (callback) {
    const self = this;

    GUI.tab_switch_cleanup(function () {
        self.initialize();

        if (callback) {
            callback();
        }
    });
};

firmware_flasher.showDialogVerifyBoard = function (selected, verified, onAccept, onAbort) {
    const dialogVerifyBoard = $("#dialog-verify-board")[0];

    $("#dialog-verify-board-content").html(
        i18n.getMessage("firmwareFlasherVerifyBoard", { selected_board: selected, verified_board: verified }),
    );

    if (!dialogVerifyBoard.hasAttribute("open")) {
        dialogVerifyBoard.showModal();

        $("#dialog-verify-board-continue-confirmbtn").on("click", function () {
            dialogVerifyBoard.close();
            onAccept();
        });

        $("#dialog-verify-board-abort-confirmbtn").on("click", function () {
            dialogVerifyBoard.close();
            onAbort();
        });
    }
};

firmware_flasher.FLASH_MESSAGE_TYPES = {
    NEUTRAL: "NEUTRAL",
    VALID: "VALID",
    INVALID: "INVALID",
    ACTION: "ACTION",
};

firmware_flasher.flashingMessage = function (message, type) {
    let self = this;

    let progressLabel_e = $("span.progressLabel");
    switch (type) {
        case self.FLASH_MESSAGE_TYPES.VALID:
            progressLabel_e.removeClass("invalid actionRequired").addClass("valid");
            break;
        case self.FLASH_MESSAGE_TYPES.INVALID:
            progressLabel_e.removeClass("valid actionRequired").addClass("invalid");
            break;
        case self.FLASH_MESSAGE_TYPES.ACTION:
            progressLabel_e.removeClass("valid invalid").addClass("actionRequired");
            break;
        case self.FLASH_MESSAGE_TYPES.NEUTRAL:
        default:
            progressLabel_e.removeClass("valid invalid actionRequired");
            break;
    }
    if (message !== null) {
        progressLabel_e.html(message);
    }

    return self;
};

firmware_flasher.flashProgress = function (value) {
    $(".progress").val(value);

    return this;
};

firmware_flasher.injectTargetInfo = function (targetConfig, targetName, manufacturerId, commitInfo) {
    const targetInfoLineRegex = /^# config: manufacturer_id: .*, board_name: .*, version: .*$, date: .*\n/gm;

    const config = targetConfig.replace(targetInfoLineRegex, "");

    const targetInfo = `# config: manufacturer_id: ${manufacturerId}, board_name: ${targetName}, version: ${commitInfo.commitHash}, date: ${commitInfo.date}`;

    const lines = config.split("\n");
    lines.splice(1, 0, targetInfo);
    return lines.join("\n");
};

firmware_flasher.flashELRSFirmware = async function () {
    this.failed = false;
    this.step++;
    this.updateELRSFlashingUI();

    try {
        this.progressText = "";
        await this.flasher.flash(this.files.firmwareFiles, this.fullErase, (fileIndex, written, total) => {
            this.progressText = `${fileIndex + 1} of ${this.files.firmwareFiles.length}`;
            this.progress = Math.round((written / total) * 100);
            this.updateELRSFlashingUI();
        });
        await this.flasher.close();
        this.flasher = null;
        this.device = null;
        this.flashComplete = true;
        this.step++;
        this.updateELRSFlashingUI();
    } catch (e) {
        console.log(e);
        this.failed = true;
        this.updateELRSFlashingUI();
    }
};

TABS.firmware_flasher = firmware_flasher;

export { firmware_flasher };
