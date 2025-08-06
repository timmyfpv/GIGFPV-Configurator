import GUI, { TABS } from "../gui";
import { i18n } from "../localization";
import $ from "jquery";

const elrs_flasher = {};

elrs_flasher.initialize = function (callback) {
    if (GUI.active_tab != "elrs_flasher") {
        GUI.active_tab = "elrs_flasher";
    }

    $("#content").load("./tabs/elrs_flasher.html", function () {
        i18n.localizePage();

        // Initialize the ELRS flasher interface
        elrs_flasher.initializeInterface();

        GUI.content_ready(callback);
    });
};

elrs_flasher.initializeInterface = function () {
    // Initialize device type selector
    $("#elrs_device_type").on("change", function () {
        const deviceType = $(this).val();
        if (deviceType) {
            elrs_flasher.updatePortList(deviceType);
        }
    });

    // Initialize connect button
    $("#elrs_connect").on("click", function () {
        elrs_flasher.connectToDevice();
    });

    // Initialize flash button
    $("#elrs_flash").on("click", function () {
        elrs_flasher.flashFirmware();
    });

    // Initialize backup button
    $("#elrs_backup").on("click", function () {
        elrs_flasher.backupFirmware();
    });

    // Initialize port selector
    $("#elrs_device_port").on("change", function () {
        const port = $(this).val();
        if (port) {
            $("#elrs_connect").prop("disabled", false);
        } else {
            $("#elrs_connect").prop("disabled", true);
        }
    });

    // Initialize firmware version selector
    $("#elrs_firmware_version").on("change", function () {
        const firmwareVersion = $(this).val();
        if (firmwareVersion && $("#elrs_device_port").val()) {
            $("#elrs_flash").prop("disabled", false);
        } else {
            $("#elrs_flasher").prop("disabled", true);
        }
    });
};

elrs_flasher.updatePortList = function (deviceType) {
    // This would typically scan for available ports
    // For now, just add some dummy options
    const portSelect = $("#elrs_device_port");
    portSelect.empty();
    portSelect.append('<option value="">Select port...</option>');

    if (deviceType === "receiver") {
        portSelect.append('<option value="COM1">COM1 - ELRS Receiver</option>');
        portSelect.append('<option value="COM2">COM2 - ELRS Receiver</option>');
    } else if (deviceType === "transmitter") {
        portSelect.append('<option value="COM3">COM3 - ELRS Transmitter</option>');
        portSelect.append('<option value="COM4">COM4 - ELRS Transmitter</option>');
    }
};

elrs_flasher.connectToDevice = function () {
    const port = $("#elrs_device_port").val();
    const deviceType = $("#elrs_device_type").val();

    if (!port || !deviceType) {
        elrs_flasher.updateStatus("Please select both device type and port", "error");
        return;
    }

    elrs_flasher.updateStatus(`Connecting to ${  deviceType  } on ${  port  }...`, "info");

    // Simulate connection process
    setTimeout(() => {
        elrs_flasher.updateStatus(`Connected to ${  deviceType  } on ${  port}`, "success");
        $("#elrs_backup").prop("disabled", false);

        // Load available firmware versions
        elrs_flasher.loadFirmwareVersions(deviceType);
    }, 2000);
};

elrs_flasher.loadFirmwareVersions = function (deviceType) {
    const firmwareSelect = $("#elrs_firmware_version");
    firmwareSelect.empty();
    firmwareSelect.append('<option value="">Select firmware version...</option>');

    if (deviceType === "receiver") {
        firmwareSelect.append('<option value="3.0.0">ELRS 3.0.0 (Receiver)</option>');
        firmwareSelect.append('<option value="3.1.0">ELRS 3.1.0 (Receiver)</option>');
        firmwareSelect.append('<option value="3.2.0">ELRS 3.2.0 (Receiver)</option>');
    } else if (deviceType === "transmitter") {
        firmwareSelect.append('<option value="3.0.0">ELRS 3.0.0 (Transmitter)</option>');
        firmwareSelect.append('<option value="3.1.0">ELRS 3.1.0 (Transmitter)</option>');
        firmwareSelect.append('<option value="3.2.0">ELRS 3.2.0 (Transmitter)</option>');
    }
};

elrs_flasher.flashFirmware = function () {
    const firmwareVersion = $("#elrs_firmware_version").val();
    const deviceType = $("#elrs_device_type").val();

    if (!firmwareVersion) {
        elrs_flasher.updateStatus("Please select a firmware version", "error");
        return;
    }

    elrs_flasher.updateStatus(`Flashing ${  firmwareVersion  } to ${  deviceType  }...`, "info");

    // Simulate flashing process
    setTimeout(() => {
        elrs_flasher.updateStatus("Firmware flashed successfully!", "success");
    }, 3000);
};

elrs_flasher.backupFirmware = function () {
    const deviceType = $("#elrs_device_type").val();

    elrs_flasher.updateStatus(`Backing up current firmware from ${  deviceType  }...`, "info");

    // Simulate backup process
    setTimeout(() => {
        elrs_flasher.updateStatus("Firmware backup completed successfully!", "success");
    }, 2000);
};

elrs_flasher.updateStatus = function (message, type) {
    const statusDiv = $("#elrs_status");
    statusDiv.text(message);

    // Remove existing status classes
    statusDiv.removeClass("status-info status-success status-error");

    // Add appropriate status class
    if (type === "info") {
        statusDiv.addClass("status-info");
    } else if (type === "success") {
        statusDiv.addClass("status-success");
    } else if (type === "error") {
        statusDiv.addClass("status-error");
    }
};

elrs_flasher.cleanup = function (callback) {
    if (callback) callback();
};

TABS.elrs_flasher = elrs_flasher;

export { elrs_flasher };
