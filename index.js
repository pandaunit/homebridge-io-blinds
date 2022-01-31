var MCP23017 = require('node-mcp23017');
var Service, Characteristic, PersistPath;

const STATE_DECREASING = 0;
const STATE_INCREASING = 1;
const STATE_STOPPED = 2;

module.exports = function (homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    PersistPath = homebridge.user.persistPath();
    homebridge.registerAccessory('homebridge-io-blinds', 'BlindsIO', BlindsAccessory);
}

function BlindsAccessory(log, config) {
    this.log = log;
    this.name = config['name'];
    this.address = parseInt(config['address']) || parseInt("0x27");
    this.device = config['device'] || 1;
    this.debug = config['debug'] || false;

    this.pinUpInput = config['pinUpInput'];
    this.pinUpOutput = config['pinUpOutput'];
    this.pinDownInput = config['pinDownInput'];
    this.pinDownOutput = config['pinDownOutput'];
    this.durationUp = config['durationUp'];
    this.durationDown = config['durationDown'];
    this.durationOffset = config['durationOffset'];
    // this.pinClosed = config['pinClosed'];
    // this.pinOpen = config['pinOpen'];
    this.inputInterval = config['inputInterval'] || 100;

    this.activeLow = config['activeLow'] || true;
    this.initialState = this.activeLow ? 1 : 0;
    this.activeState = this.activeLow ? 0 : 1;
    // this.reedSwitchActiveState = config['reedSwitchActiveLow'] ? rpio.LOW : rpio.HIGH;
    this.lastInputValue = true;

    this.storage = require('node-persist');
    this.storage.initSync({ dir: PersistPath, forgiveParseErrors: true });

    var cachedCurrentPosition = this.storage.getItemSync(this.name);
    if ((cachedCurrentPosition === undefined) || (cachedCurrentPosition === false)) {
        this.currentPosition = 0; // down by default
    } else {
        this.currentPosition = cachedCurrentPosition;
    }

    this.targetPosition = this.currentPosition;
    this.positionState = STATE_STOPPED;

    this.service = new Service.WindowCovering(this.name);

    this.infoService = new Service.AccessoryInformation();
    this.infoService
        .setCharacteristic(Characteristic.Manufacturer, 'Smart Panda')
        .setCharacteristic(Characteristic.Model, 'BC1')
        .setCharacteristic(Characteristic.SerialNumber, 'Version 1.0.0-beta.0');

    this.finalBlindsStateTimeout;
    this.togglePinTimeout;
    this.intervalUp = this.durationUp / 100;
    this.intervalDown = this.durationDown / 100;
    this.currentPositionInterval;

    this.mcp = new MCP23017({
        address: this.address,
        device: this.device,
        debug: this.debug
    });

    this.mcp.pinMode(this.pinUpInput, this.mcp.INPUT_PULLUP);
    this.mcp.pinMode(this.pinDownInput, this.mcp.INPUT_PULLUP);
    this.mcp.pinMode(this.pinUpOutput, this.mcp.OUTPUT);
    this.mcp.pinMode(this.pinDownOutput, this.mcp.OUTPUT);
    this.mcp.digitalWrite(this.pinUpOutput, this.initialState);
    this.mcp.digitalWrite(this.pinDownOutput, this.initialState);

    this.service
        .getCharacteristic(Characteristic.CurrentPosition)
        .on('get', this.getCurrentPosition.bind(this));

    this.service
        .getCharacteristic(Characteristic.PositionState)
        .on('get', this.getPositionState.bind(this));

    this.service
        .getCharacteristic(Characteristic.TargetPosition)
        .on('get', this.getTargetPosition.bind(this))
        .on('set', this.setTargetPosition.bind(this));

    setInterval(function () {
        var readInput = function () {
            return function (pin, err, value) {
                if (this.lastInputValue == value) {
                    return;
                }
                if (value == false && this.currentState == false) { // TODO: stop blinds if moving, physical has precedence, up & down resolution
                    this.log("Physical switch on");
                    this.switchLight(true);
                } else if (value == false && this.currentState == true) {
                    this.log("Physical switch off");
                    this.switchLight(false);
                } else if (err) {
                    this.log(err);
                }
                this.lastInputValue = value;
            }
        }
        this.mcp.digitalRead(this.pinUpInput, readInput().bind(this));
        this.mcp.digitalRead(this.pinDownInput, readInput().bind(this));
    }.bind(this), this.inputInterval);
}

BlindsAccessory.prototype.getPositionState = function (callback) {
    this.log("Position state: %s", this.positionState);
    callback(null, this.positionState);
}

BlindsAccessory.prototype.getCurrentPosition = function (callback) {
    this.log("Current position: %s", this.currentPosition);
    callback(null, this.currentPosition);
}

BlindsAccessory.prototype.getTargetPosition = function (callback) {
    this.log("Target position: %s", this.targetPosition);
    callback(null, this.targetPosition);
}

BlindsAccessory.prototype.setTargetPosition = function (position, callback) {
    this.log("Setting target position to %s", position);
    this.targetPosition = position;
    var moveUp = (this.targetPosition >= this.currentPosition);
    var duration;

    if (this.positionState != STATE_STOPPED) {
        this.log("Blind is moving, current position %s", this.currentPosition);
        if (this.oppositeDirection(moveUp)) {
            this.log('Stopping the blind because of opposite direction');
            this.mcp.digitalWrite((moveUp ? this.pinDownOutput : this.pinUpOutput), this.initialState);
            // setTimeout(function () {
            //     this.mcp.digitalWrite((moveUp ? this.pinDownOutput : this.pinUpOutput), this.initialState);
            // }.bind(this), 2000);
        }
        clearInterval(this.currentPositionInterval);
        clearTimeout(this.finalBlindsStateTimeout);
        clearTimeout(this.togglePinTimeout);
    }

    if (this.currentPosition == position) {
        this.log('Current position already matches target position. There is nothing to do.');
        callback();
        return true;
    }

    if (moveUp) {
        duration = Math.round((this.targetPosition - this.currentPosition) / 100 * this.durationUp);
        this.currentPositionInterval = setInterval(this.setCurrentPosition.bind(this, moveUp), this.intervalUp);
    } else {
        duration = Math.round((this.currentPosition - this.targetPosition) / 100 * this.durationDown);
        this.currentPositionInterval = setInterval(this.setCurrentPosition.bind(this, moveUp), this.intervalDown);
    }

    this.log((moveUp ? 'Moving up' : 'Moving down') + ". Duration: %s ms.", duration);

    this.service.setCharacteristic(Characteristic.PositionState, (moveUp ? STATE_INCREASING : STATE_DECREASING));
    this.positionState = (moveUp ? STATE_INCREASING : STATE_DECREASING);

    this.finalBlindsStateTimeout = setTimeout(this.setFinalBlindsState.bind(this), duration);
    this.togglePin((moveUp ? this.pinUp : this.pinDown), duration);

    callback();
    return true;
}

BlindsAccessory.prototype.togglePin = function (pin, duration) {
    if (rpio.read(pin) != this.activeState) rpio.write(pin, this.activeState);
    if (this.durationOffset && (this.targetPosition == 0 || this.targetPosition == 100)) duration += this.durationOffset;
    this.togglePinTimeout = setTimeout(function () {
        rpio.write(pin, this.initialState);
    }.bind(this), parseInt(duration));
}





BlindsAccessory.prototype.getPowerState = function (callback) {
    this.log("Light power state: %s", this.currentState);
    callback(null, this.currentState);
}

BlindsAccessory.prototype.setPowerState = function (state, callback) {
    this.switchLight(state);
    callback();
}

BlindsAccessory.prototype.switchLight = function (state) {
    this.log("Setting power state to %s", state);
    var signal = (state ? this.activeState : this.initialState);
    this.mcp.digitalWrite(this.pinOutput, signal);
    this.currentState = state;
    this.storage.setItemSync(this.name, this.currentState);
    this.service.updateCharacteristic(Characteristic.On, this.currentState);
}



BlindsAccessory.prototype.oppositeDirection = function (moveUp) {
    return (this.positionState == STATE_INCREASING && !moveUp) || (this.positionState == STATE_DECREASING && moveUp);
}

BlindsAccessory.prototype.getServices = function () {
    return [this.infoService, this.service];
}
