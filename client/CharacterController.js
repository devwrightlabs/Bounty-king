/**
 * Operation: Archipelago — Character Controller State Machine
 * Engine: PlayCanvas (component-based, runs on pc.Entity)
 *
 * Implements CoD Mobile-style movement FSM:
 *   IDLE → WALK → SPRINT → SLIDE → CROUCH → ADS → VAULT
 *   + Vehicle seat toggling (DRIVER / PASSENGER / GUNNER)
 *
 * Touch inputs are fed into this controller via TouchHUD.js
 * Photon Fusion NetworkTransform syncs position/rotation each tick
 */

import * as pc from 'playcanvas';

// ---------------------------------------------------------------------------
// CONSTANTS
// ---------------------------------------------------------------------------
const WALK_SPEED       = 3.5;   // m/s
const SPRINT_SPEED     = 6.5;   // m/s
const CROUCH_SPEED     = 1.8;   // m/s
const SLIDE_SPEED      = 8.0;   // m/s — initial impulse
const SLIDE_FRICTION   = 0.92;  // velocity decay per frame
const SLIDE_MIN_SPEED  = 1.5;   // cancel slide below this
const JUMP_FORCE       = 5.2;
const GRAVITY          = -15.0;
const VAULT_DURATION   = 0.35;  // seconds
const ADS_FOV          = 45;
const DEFAULT_FOV      = 75;
const SLIDE_CANCEL_WINDOW = 0.18; // seconds after slide input to cancel into sprint

// ---------------------------------------------------------------------------
// STATE ENUM
// ---------------------------------------------------------------------------
export const PlayerState = Object.freeze({
    IDLE:             'IDLE',
    WALKING:          'WALKING',
    SPRINTING:        'SPRINTING',
    SLIDING:          'SLIDING',
    CROUCHING:        'CROUCHING',
    PRONE:            'PRONE',
    JUMPING:          'JUMPING',
    FALLING:          'FALLING',
    ADS:              'ADS',            // Aim-Down-Sights (stacks with movement states)
    VAULTING:         'VAULTING',
    DEAD:             'DEAD',
    SPECTATING:       'SPECTATING',
    IN_VEHICLE:       'IN_VEHICLE',
});

export const VehicleSeat = Object.freeze({
    NONE:       'NONE',
    DRIVER:     'DRIVER',
    PASSENGER:  'PASSENGER',
    GUNNER:     'GUNNER',
});

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------
function lerp(a, b, t) { return a + (b - a) * t; }

// ---------------------------------------------------------------------------
// CharacterController
// Attach to the root player entity. Expects children:
//   - 'Camera'       : pc.Entity with camera component (1st-person head)
//   - 'WeaponRoot'   : pc.Entity holding weapon mesh + anim
//   - 'Body'         : pc.Entity with collision/rigidbody
// ---------------------------------------------------------------------------
export class CharacterController extends pc.ScriptType {

    // ---- PlayCanvas script attribute declarations ----
    static get scriptName() { return 'CharacterController'; }

    initialize() {
        // ---- component refs ----
        this.camera     = this.entity.findByName('Camera');
        this.weaponRoot = this.entity.findByName('WeaponRoot');
        this.body       = this.entity.findByName('Body');
        this.rb         = this.body.rigidbody;

        // ---- FSM ----
        this.state          = PlayerState.IDLE;
        this.prevState      = PlayerState.IDLE;
        this.vehicleSeat    = VehicleSeat.NONE;
        this.currentVehicle = null;

        // ---- movement internals ----
        this.velocity       = new pc.Vec3();
        this.moveDir        = new pc.Vec3();
        this.isGrounded     = false;
        this.slideTimer     = 0;
        this.vaultTimer     = 0;
        this.vaultTarget    = new pc.Vec3();
        this.slideCancel    = false;
        this.slideCancelTimer = 0;

        // ---- camera / look ----
        this.yaw            = 0;
        this.pitch          = 0;
        this.currentFOV     = DEFAULT_FOV;
        this.targetFOV      = DEFAULT_FOV;
        this.cameraShake    = new pc.Vec3();

        // ---- weapon sway ----
        this.weaponSwayTarget = new pc.Vec3();
        this.weaponSwayPos    = new pc.Vec3();
        this.recoilOffset     = new pc.Vec3();

        // ---- input state (populated each frame by TouchHUD) ----
        this.input = {
            moveX:       0,   // joystick normalized -1..1
            moveY:       0,
            lookDeltaX:  0,   // gyro + touch delta
            lookDeltaY:  0,
            sprint:      false,
            crouch:      false,
            jump:        false,
            fire:        false,
            ads:         false,
            reload:      false,
            vault:       false,
            interact:    false,
            swapSeat:    false,
        };

        // ---- bind ground detection ----
        this.body.collision.on('collisionstart', this._onCollision, this);

        // ---- animation state machine ref (PlayCanvas Anim component) ----
        this.anim = this.entity.anim;

        this._transitionState(PlayerState.IDLE);
    }

    // =========================================================================
    // MAIN UPDATE — called every frame at 60 FPS
    // =========================================================================
    update(dt) {
        if (this.state === PlayerState.DEAD || this.state === PlayerState.SPECTATING) return;

        if (this.state === PlayerState.IN_VEHICLE) {
            this._updateVehicleState(dt);
            return;
        }

        this._checkGrounded();
        this._processFSM(dt);
        this._applyMovement(dt);
        this._updateCamera(dt);
        this._updateWeaponSway(dt);
        this._updateFOV(dt);
    }

    // =========================================================================
    // FSM PROCESSOR
    // =========================================================================
    _processFSM(dt) {
        const i = this.input;
        const moving = (Math.abs(i.moveX) > 0.05 || Math.abs(i.moveY) > 0.05);

        switch (this.state) {

            // ---- IDLE ----
            case PlayerState.IDLE:
                if (!this.isGrounded)                       return this._transitionState(PlayerState.FALLING);
                if (moving && i.sprint)                     return this._transitionState(PlayerState.SPRINTING);
                if (moving)                                 return this._transitionState(PlayerState.WALKING);
                if (i.crouch)                               return this._transitionState(PlayerState.CROUCHING);
                if (i.jump)                                 return this._applyJump();
                break;

            // ---- WALKING ----
            case PlayerState.WALKING:
                if (!this.isGrounded)                       return this._transitionState(PlayerState.FALLING);
                if (!moving)                                return this._transitionState(PlayerState.IDLE);
                if (i.sprint && moving)                     return this._transitionState(PlayerState.SPRINTING);
                if (i.crouch)                               return this._transitionState(PlayerState.CROUCHING);
                if (i.jump)                                 return this._applyJump();
                break;

            // ---- SPRINTING ----
            case PlayerState.SPRINTING:
                if (!this.isGrounded)                       return this._transitionState(PlayerState.FALLING);
                if (!moving)                                return this._transitionState(PlayerState.IDLE);
                if (!i.sprint)                              return this._transitionState(PlayerState.WALKING);
                if (i.crouch || i.jump) {
                    // Slide!
                    return this._transitionState(PlayerState.SLIDING);
                }
                if (i.vault)                                return this._tryVault();
                break;

            // ---- SLIDING ----
            case PlayerState.SLIDING:
                this.slideTimer += dt;
                this.slideCancelTimer += dt;

                // Slide cancel: tap sprint again within cancel window → back to sprint
                if (i.sprint && this.slideCancelTimer < SLIDE_CANCEL_WINDOW) {
                    return this._transitionState(PlayerState.SPRINTING);
                }

                // Slide ends when velocity drops or timer expires
                const slideMag = new pc.Vec2(this.velocity.x, this.velocity.z).length();
                if (slideMag < SLIDE_MIN_SPEED || this.slideTimer > 0.8) {
                    return i.crouch
                        ? this._transitionState(PlayerState.CROUCHING)
                        : this._transitionState(PlayerState.IDLE);
                }
                break;

            // ---- CROUCHING ----
            case PlayerState.CROUCHING:
                if (!this.isGrounded)                       return this._transitionState(PlayerState.FALLING);
                if (!i.crouch)                              return this._transitionState(PlayerState.IDLE);
                if (i.jump)                                 return this._applyJump();
                break;

            // ---- JUMPING ----
            case PlayerState.JUMPING:
                if (this.velocity.y < 0)                   return this._transitionState(PlayerState.FALLING);
                break;

            // ---- FALLING ----
            case PlayerState.FALLING:
                if (this.isGrounded) {
                    // Landing — trigger land shake
                    this._triggerLandShake();
                    return this._transitionState(moving ? PlayerState.WALKING : PlayerState.IDLE);
                }
                break;

            // ---- ADS ----
            case PlayerState.ADS:
                if (!i.ads) {
                    this.targetFOV = DEFAULT_FOV;
                    return this._transitionState(this.prevState);
                }
                break;

            // ---- VAULTING ----
            case PlayerState.VAULTING:
                this.vaultTimer += dt;
                if (this.vaultTimer >= VAULT_DURATION) {
                    this.entity.setPosition(this.vaultTarget);
                    return this._transitionState(PlayerState.IDLE);
                }
                break;
        }

        // ADS can stack on top of most ground states
        if (i.ads && this.state !== PlayerState.ADS && this.isGrounded) {
            this.prevState = this.state;
            this.targetFOV = ADS_FOV;
            this._transitionState(PlayerState.ADS);
        }
    }

    // =========================================================================
    // STATE TRANSITIONS
    // =========================================================================
    _transitionState(newState) {
        const old = this.state;
        this.prevState = old;
        this.state = newState;

        // Reset state timers
        if (newState === PlayerState.SLIDING) {
            this.slideTimer = 0;
            this.slideCancelTimer = 0;
            // Slide impulse in current look direction
            const fwd = this.entity.forward.clone().scale(SLIDE_SPEED);
            this.velocity.x = fwd.x;
            this.velocity.z = fwd.z;
        }

        if (newState === PlayerState.VAULTING) {
            this.vaultTimer = 0;
        }

        // Update camera height
        const camHeights = {
            [PlayerState.CROUCHING]: 0.6,
            [PlayerState.PRONE]:     0.2,
            [PlayerState.SLIDING]:   0.4,
            [PlayerState.IDLE]:      1.7,
            [PlayerState.WALKING]:   1.7,
            [PlayerState.SPRINTING]: 1.7,
        };
        if (camHeights[newState] !== undefined) {
            this._setCameraHeight(camHeights[newState]);
        }

        // Drive anim state machine
        if (this.anim) {
            this.anim.setBoolean('isGrounded',  this.isGrounded);
            this.anim.setBoolean('isSprinting', newState === PlayerState.SPRINTING);
            this.anim.setBoolean('isCrouching', newState === PlayerState.CROUCHING);
            this.anim.setBoolean('isSliding',   newState === PlayerState.SLIDING);
            this.anim.setBoolean('isADS',       newState === PlayerState.ADS);
            this.anim.setTrigger('onVault',     newState === PlayerState.VAULTING);
            this.anim.setBoolean('inVehicle',   newState === PlayerState.IN_VEHICLE);
        }
    }

    // =========================================================================
    // MOVEMENT APPLICATION
    // =========================================================================
    _applyMovement(dt) {
        const i = this.input;

        let speed;
        switch (this.state) {
            case PlayerState.SPRINTING:  speed = SPRINT_SPEED;  break;
            case PlayerState.CROUCHING:  speed = CROUCH_SPEED;  break;
            case PlayerState.SLIDING:    speed = 0; break; // velocity handled at transition
            default:                     speed = WALK_SPEED;
        }

        if (this.state !== PlayerState.SLIDING &&
            this.state !== PlayerState.VAULTING &&
            this.state !== PlayerState.JUMPING) {

            // Build move direction in world space from camera yaw + input
            const rad = this.yaw * pc.math.DEG_TO_RAD;
            this.moveDir.set(
                i.moveX * Math.cos(rad) + i.moveY * Math.sin(rad),
                0,
                -i.moveX * Math.sin(rad) + i.moveY * Math.cos(rad)
            ).normalize();

            this.velocity.x = this.moveDir.x * speed;
            this.velocity.z = this.moveDir.z * speed;
        }

        // Gravity
        if (!this.isGrounded) {
            this.velocity.y += GRAVITY * dt;
        } else if (this.velocity.y < 0) {
            this.velocity.y = 0;
        }

        // Slide decay
        if (this.state === PlayerState.SLIDING) {
            this.velocity.x *= SLIDE_FRICTION;
            this.velocity.z *= SLIDE_FRICTION;
        }

        // Apply to rigidbody
        this.rb.linearVelocity = this.velocity;
    }

    _applyJump() {
        this.velocity.y = JUMP_FORCE;
        this.isGrounded  = false;
        this._transitionState(PlayerState.JUMPING);
        if (this.anim) this.anim.setTrigger('onJump');
    }

    // =========================================================================
    // VAULT SYSTEM
    // =========================================================================
    _tryVault() {
        // Raycast forward to detect obstacle top surface
        const origin = this.entity.getPosition().clone();
        origin.y += 1.0;
        const dir    = this.entity.forward.clone();
        const result = this.app.systems.rigidbody.raycastFirst(
            origin, dir.scale(1.2).add(origin)
        );

        if (result && result.point) {
            const top = result.point.clone();
            top.y += 0.1;  // land slightly above surface
            this.vaultTarget.copy(top);
            this._transitionState(PlayerState.VAULTING);
        }
    }

    // =========================================================================
    // CAMERA SYSTEM
    // =========================================================================
    _updateCamera(dt) {
        const i = this.input;

        this.yaw   += i.lookDeltaX;
        this.pitch  = pc.math.clamp(this.pitch - i.lookDeltaY, -80, 80);

        // Clear deltas after consuming
        this.input.lookDeltaX = 0;
        this.input.lookDeltaY = 0;

        // Apply to entity (yaw on body, pitch on camera)
        this.entity.setEulerAngles(0, this.yaw, 0);
        this.camera.setLocalEulerAngles(this.pitch, 0, 0);

        // Sprint camera tilt
        const targetRoll = (this.state === PlayerState.SPRINTING)
            ? (this.input.moveX * -3.0)
            : 0;
        const currentRot = this.camera.getLocalEulerAngles();
        this.camera.setLocalEulerAngles(
            currentRot.x,
            currentRot.y,
            lerp(currentRot.z, targetRoll, dt * 8)
        );

        // Apply camera shake
        if (this.cameraShake.length() > 0.001) {
            this.camera.translateLocal(
                this.cameraShake.x * dt,
                this.cameraShake.y * dt,
                0
            );
            this.cameraShake.scale(0.85); // decay
        }
    }

    _setCameraHeight(targetHeight) {
        const pos = this.camera.getLocalPosition();
        this.camera.setLocalPosition(pos.x, targetHeight, pos.z);
    }

    _triggerLandShake() {
        this.cameraShake.set(
            (Math.random() - 0.5) * 0.4,
            -0.3,
            0
        );
    }

    // =========================================================================
    // WEAPON SWAY
    // =========================================================================
    _updateWeaponSway(dt) {
        const i = this.input;
        // Sway target based on look delta and movement
        this.weaponSwayTarget.set(
            -i.lookDeltaX * 0.02,
            -i.lookDeltaY * 0.02,
            0
        );

        // ADS reduces sway
        const swayFactor = (this.state === PlayerState.ADS) ? 0.3 : 1.0;
        this.weaponSwayTarget.scale(swayFactor);

        // Lerp weapon position toward target
        this.weaponSwayPos.lerp(this.weaponSwayPos, this.weaponSwayTarget, dt * 6);
        this.weaponRoot.setLocalPosition(
            this.weaponSwayPos.x + this.recoilOffset.x,
            this.weaponSwayPos.y + this.recoilOffset.y,
            this.weaponSwayPos.z
        );

        // Decay recoil offset
        this.recoilOffset.lerp(this.recoilOffset, pc.Vec3.ZERO, dt * 14);
    }

    // Called by WeaponSystem on each fired round
    applyRecoil(kickX, kickY) {
        this.recoilOffset.x += kickX;
        this.recoilOffset.y += kickY;
        this.pitch           = pc.math.clamp(this.pitch - kickY * 0.8, -80, 80);
    }

    // =========================================================================
    // FOV TRANSITION (ADS / Sprint)
    // =========================================================================
    _updateFOV(dt) {
        const sprintFOV = (this.state === PlayerState.SPRINTING) ? DEFAULT_FOV + 5 : DEFAULT_FOV;
        const wantFOV   = (this.state === PlayerState.ADS) ? ADS_FOV : sprintFOV;

        this.currentFOV = lerp(this.currentFOV, wantFOV, dt * 12);
        if (this.camera.camera) {
            this.camera.camera.fov = this.currentFOV;
        }
    }

    // =========================================================================
    // VEHICLE INTEGRATION
    // =========================================================================
    enterVehicle(vehicle, seat) {
        this.currentVehicle = vehicle;
        this.vehicleSeat    = seat;
        this._transitionState(PlayerState.IN_VEHICLE);

        // Attach camera to vehicle camera mount
        const mount = vehicle.getSeatCameraMount(seat);
        if (mount) {
            this.camera.reparent(mount);
            this.camera.setLocalPosition(0, 0, 0);
            this.camera.setLocalEulerAngles(0, 0, 0);
        }

        // Disable character collider while in vehicle
        this.body.collision.enabled = false;
        this.rb.enabled             = false;
    }

    exitVehicle() {
        if (!this.currentVehicle) return;

        // Restore camera to character
        this.camera.reparent(this.entity);
        this._setCameraHeight(1.7);

        // Place player next to vehicle exit point
        const exitPoint = this.currentVehicle.getExitPoint(this.vehicleSeat);
        this.entity.setPosition(exitPoint);

        this.body.collision.enabled = true;
        this.rb.enabled             = true;

        this.currentVehicle = null;
        this.vehicleSeat    = VehicleSeat.NONE;

        this._transitionState(PlayerState.IDLE);
    }

    swapVehicleSeat(newSeat) {
        if (!this.currentVehicle) return;
        if (!this.currentVehicle.isSeatAvailable(newSeat)) return;

        const oldSeat    = this.vehicleSeat;
        this.vehicleSeat = newSeat;

        // Animate player across seats (brief transition)
        this.currentVehicle.transferPassenger(this, oldSeat, newSeat);

        // Update camera mount
        const mount = this.currentVehicle.getSeatCameraMount(newSeat);
        if (mount) {
            this.camera.reparent(mount);
            this.camera.setLocalPosition(0, 0, 0);
        }

        // Driver seat controls movement; passenger/gunner seats enable free-look + firing
        if (this.anim) {
            this.anim.setString('vehicleSeat', newSeat);
        }
    }

    _updateVehicleState(dt) {
        // In-vehicle: only process look (for free-look / gunner aim) and seat swap input
        if (this.input.lookDeltaX || this.input.lookDeltaY) {
            if (this.vehicleSeat !== VehicleSeat.DRIVER) {
                // Free-look while passenger/gunner
                this.yaw   += this.input.lookDeltaX;
                this.pitch  = pc.math.clamp(this.pitch - this.input.lookDeltaY, -60, 60);
                this.camera.setLocalEulerAngles(this.pitch, this.yaw, 0);
            }
            this.input.lookDeltaX = 0;
            this.input.lookDeltaY = 0;
        }

        if (this.input.swapSeat) {
            const nextSeat = this.currentVehicle.getNextAvailableSeat(this.vehicleSeat);
            if (nextSeat) this.swapVehicleSeat(nextSeat);
            this.input.swapSeat = false;
        }

        if (this.input.interact) {
            this.exitVehicle();
            this.input.interact = false;
        }
    }

    // =========================================================================
    // GROUND DETECTION (via continuous collision)
    // =========================================================================
    _checkGrounded() {
        const pos    = this.entity.getPosition();
        const below  = pos.clone();
        below.y     -= 0.1;
        const result = this.app.systems.rigidbody.raycastFirst(pos, below);
        this.isGrounded = !!result;
    }

    _onCollision(result) {
        // Supplement raycast with collision events for responsiveness
        if (result.other.tags.has('ground') || result.other.tags.has('floor')) {
            this.isGrounded = true;
        }
    }

    // =========================================================================
    // DEATH & RESPAWN
    // =========================================================================
    die(killerData) {
        this._transitionState(PlayerState.DEAD);
        this.rb.linearVelocity = pc.Vec3.ZERO;

        if (this.anim) this.anim.setTrigger('onDeath');

        // Emit event for HUD, death-screen UI, and dog-tag spawner
        this.entity.fire('player:died', {
            killer: killerData,
            position: this.entity.getPosition().clone(),
        });
    }

    respawn(spawnPoint) {
        this.entity.setPosition(spawnPoint);
        this.velocity.set(0, 0, 0);
        this.yaw   = 0;
        this.pitch = 0;
        this._transitionState(PlayerState.IDLE);
        this.entity.fire('player:respawned');
    }
}

// Register with PlayCanvas
pc.registerScript(CharacterController, CharacterController.scriptName);
