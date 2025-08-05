import BatteryLegend from "../components/quad-status/BatteryLegend.vue";
import GigfpvLogo from "../components/gigfpv-logo/GigfpvLogo.vue";
import StatusBar from "../components/status-bar/StatusBar.vue";
import BatteryIcon from "../components/quad-status/BatteryIcon.vue";
import PortPicker from "../components/port-picker/PortPicker.vue";

// Create a Vue plugin that registers all components globally
export const BetaflightComponents = {
    install(app) {
        // Register all components globally
        app.component("gigfpv-logo", GigfpvLogo);
        app.component("BatteryLegend", BatteryLegend);
        app.component("StatusBar", StatusBar);
        app.component("BatteryIcon", BatteryIcon);
        app.component("PortPicker", PortPicker);
    },
};
