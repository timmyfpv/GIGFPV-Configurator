<template>
    <div class="logo">
        <div class="logo_text">
            <span v-if="firmwareVersion && firmwareId">
                {{ $t("versionLabelFirmware") }}: {{ firmwareVersion }}
                {{ firmwareId }}
            </span>
            <span v-if="hardwareId"> {{ $t("versionLabelTarget") }}: {{ hardwareId }} </span>
        </div>
    </div>
</template>

<script>
export default {
    props: {
        configuratorVersion: {
            type: String,
            required: true,
        },
        firmwareVersion: {
            type: String,
            default: "",
        },
        firmwareId: {
            type: String,
            default: "",
        },
        hardwareId: {
            type: String,
            default: "",
        },
    },
};
</script>

<style>
.logo {
    height: 70px;
    width: 240px;
    background-image: url(../../images/gigfpv-logo-black.png);
    background-repeat: no-repeat;
    background-position: 15px center;
    background-size: 70px 70px;
    position: relative;
}

.dark-theme .logo {
    background-image: url(../../images/gigfpv-logo-white.png);
}

.logo_text {
    position: absolute;
    left: 95px;
    top: 25px;
    color: var(--text);
    font-size: 10px;
    display: flex;
    flex-direction: column;
    opacity: 0.8;
}

.tab_container .logo {
    display: none;
}

@media all and (max-width: 575px) {
    .logo {
        height: 24px;
        width: 150px;
        background-image: url(../../images/gigfpv-logo-black.png);
        background-position: 5px center;
        background-size: 22px 22px;
        order: 2;
        margin-top: 0;
    }
    .dark-theme .logo {
        background-image: url(../../images/gigfpv-logo-white.png);
    }
    .logo_text {
        display: none !important;
    }
    .tab_container .logo {
        display: block;
        background-image: url(../../images/gigfpv-logo-black.png);
        background-repeat: no-repeat;
        background-position: center 20px;
        background-position-x: 20px;
        background-size: 90px 90px;
        height: 120px;
        width: auto;
        margin-top: unset;
        position: relative;
        border-bottom: 1px solid rgba(0, 0, 0, 0.3);
    }
    .dark-theme .tab_container .logo {
        background-image: url(../../images/gigfpv-logo-white.png);
    }
    .tab_container .logo .logo_text {
        display: flex !important;
        left: 120px;
        top: 25px;
    }
}

@media all and (min-width: 1125px) {
    .logo {
        width: 340px;
    }

    .logo_text {
        font-size: inherit;
        position: relative;
    }
}
</style>
