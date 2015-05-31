define([
  'lib/glMatrix',
  'misc/getUrlOptions',
  'misc/Utils',
  'math3d/Geometry'
], function (glm, getUrlOptions, Utils, Geometry) {

  'use strict';

  var vec2 = glm.vec2;
  var vec3 = glm.vec3;
  var vec4 = glm.vec4;
  var mat3 = glm.mat3;
  var mat4 = glm.mat4;
  var quat = glm.quat;

  var Camera = function () {
    var opts = getUrlOptions();
    this.mode_ = Camera.mode[opts.cameramode] || Camera.mode.ORBIT;
    this.projType_ = Camera.projType[opts.projection] || Camera.projType.PERSPECTIVE;

    this.quatRot_ = quat.create(); // quaternion rotation
    this.view_ = mat4.create(); // view matrix
    this.proj_ = mat4.create(); // projection matrix

    this.lastNormalizedMouseXY_ = [0.0, 0.0]; // last mouse position ( 0..1 )
    this.width_ = 0.0; // viewport width
    this.height_ = 0.0; // viewport height

    this.speed_ = 0.0; // solve scale issue
    this.fov_ = Math.min(opts.fov, 150); // vertical field of view

    // translation stuffs
    this.trans_ = [0.0, 0.0, 30.0];
    this.moveX_ = 0; // free look (strafe), possible values : -1, 0, 1
    this.moveZ_ = 0; // free look (strafe), possible values : -1, 0, 1

    // pivot stuffs
    this.usePivot_ = opts.pivot; // if rotation is centered around the picked point
    this.center_ = [0.0, 0.0, 0.0]; // center of rotation
    this.offset_ = [0.0, 0.0, 0.0];

    // orbit camera
    this.rotX_ = 0.0; // x rot for orbit camera
    this.rotY_ = 0.0; // y rot for orbit camera

    // near far
    this.near_ = 0.05;
    this.far_ = 5000.0;

    this.resetView();
  };

  // the camera modes
  Camera.mode = {
    ORBIT: 0,
    SPHERICAL: 1,
    PLANE: 2
  };

  // the projection type
  Camera.projType = {
    PERSPECTIVE: 0,
    ORTHOGRAPHIC: 1
  };

  Camera.prototype = {
    setProjType: function (type) {
      this.projType_ = type;
      this.updateProjection();
      this.updateView();
    },
    setMode: function (mode) {
      this.mode_ = mode;
      if (mode === Camera.mode.ORBIT)
        this.resetViewFront();
    },
    setFov: function (fov) {
      this.fov_ = fov;
      this.updateView();
      this.optimizeNearFar();
    },
    setUsePivot: function (bool) {
      this.usePivot_ = bool;
    },
    toggleUsePivot: function () {
      this.usePivot_ = !this.usePivot_;
    },
    getProjType: function () {
      return this.projType_;
    },
    isOrthographic: function () {
      return this.projType_ === Camera.projType.ORTHOGRAPHIC;
    },
    getMode: function () {
      return this.mode_;
    },
    getFov: function () {
      return this.fov_;
    },
    getUsePivot: function () {
      return this.usePivot_;
    },
    start: (function () {
      var pivot = [0.0, 0.0, 0.0];
      return function (mouseX, mouseY, main) {
        this.lastNormalizedMouseXY_ = Geometry.normalizedMouse(mouseX, mouseY, this.width_, this.height_);
        if (!this.usePivot_)
          return;
        var picking = main.getPicking();
        picking.intersectionMouseMeshes(main.getMeshes(), mouseX, mouseY);
        if (picking.getMesh()) {
          vec3.transformMat4(pivot, picking.getIntersectionPoint(), picking.getMesh().getMatrix());
          this.setPivot(pivot);
        }
      };
    })(),
    setPivot: (function () {
      var qTemp = quat.create();
      return function (pivot) {
        vec3.transformQuat(this.offset_, this.offset_, quat.invert(qTemp, this.quatRot_));
        vec3.sub(this.offset_, this.offset_, this.center_);

        // set new pivot
        vec3.copy(this.center_, pivot);
        vec3.add(this.offset_, this.offset_, this.center_);
        vec3.transformQuat(this.offset_, this.offset_, this.quatRot_);

        // adjust zoom
        if (this.projType_ === Camera.projType.PERSPECTIVE) {
          var oldZoom = this.getTransZ();
          this.trans_[2] = vec3.dist(this.computePosition(), this.center_) * this.fov_ / 45;
          var newZoom = this.getTransZ();
          this.offset_[2] += newZoom - oldZoom;
        }
      };
    })(),
    /** Compute rotation values (by updating the quaternion) */
    rotate: (function () {
      var diff = [0.0, 0.0];
      var axisRot = [0.0, 0.0, 0.0];
      var quatTmp = [0.0, 0.0, 0.0, 0.0];

      return function (mouseX, mouseY, snap) {
        if (snap)
          return this.snapClosestRotation();
        var normalizedMouseXY = Geometry.normalizedMouse(mouseX, mouseY, this.width_, this.height_);
        if (this.mode_ === Camera.mode.ORBIT) {
          vec2.sub(diff, normalizedMouseXY, this.lastNormalizedMouseXY_);
          this.rotX_ = Math.max(Math.min(this.rotX_ - diff[1] * 2, Math.PI * 0.5), -Math.PI * 0.5);
          this.rotY_ = this.rotY_ + diff[0] * 2;
          quat.identity(this.quatRot_);
          quat.rotateX(this.quatRot_, this.quatRot_, this.rotX_);
          quat.rotateY(this.quatRot_, this.quatRot_, this.rotY_);
        } else if (this.mode_ === Camera.mode.PLANE) {
          var length = vec2.dist(this.lastNormalizedMouseXY_, normalizedMouseXY);
          vec2.sub(diff, normalizedMouseXY, this.lastNormalizedMouseXY_);
          vec3.normalize(axisRot, vec3.set(axisRot, -diff[1], diff[0], 0.0));
          quat.mul(this.quatRot_, quat.setAxisAngle(quatTmp, axisRot, length * 2.0), this.quatRot_);
        } else if (this.mode_ === Camera.mode.SPHERICAL) {
          var mouseOnSphereBefore = Geometry.mouseOnUnitSphere(this.lastNormalizedMouseXY_);
          var mouseOnSphereAfter = Geometry.mouseOnUnitSphere(normalizedMouseXY);
          var angle = Math.acos(Math.min(1.0, vec3.dot(mouseOnSphereBefore, mouseOnSphereAfter)));
          vec3.normalize(axisRot, vec3.cross(axisRot, mouseOnSphereBefore, mouseOnSphereAfter));
          quat.mul(this.quatRot_, quat.setAxisAngle(quatTmp, axisRot, angle * 2.0), this.quatRot_);
        }
        this.lastNormalizedMouseXY_ = normalizedMouseXY;
        this.updateView();
      };
    })(),
    getTransZ: function () {
      return this.projType_ === Camera.projType.PERSPECTIVE ? this.trans_[2] * 45 / this.fov_ : 1000.0;
    },
    updateView: (function () {
      var up = [0.0, 1.0, 0.0];
      var eye = [0.0, 0.0, 0.0];
      var center = [0.0, 0.0, 0.0];
      var matTmp = mat4.create();
      var vecTmp = [0.0, 0.0, 0.0];

      return function () {
        var view = this.view_;
        var tx = this.trans_[0];
        var ty = this.trans_[1];

        var off = this.offset_;
        vec3.set(eye, tx - off[0], ty - off[1], this.getTransZ() - off[2]);
        vec3.set(center, tx - off[0], ty - off[1], -off[2]);
        mat4.lookAt(view, eye, center, up);

        mat4.mul(view, view, mat4.fromQuat(matTmp, this.quatRot_));
        mat4.translate(view, view, vec3.negate(vecTmp, this.center_));
      };
    })(),
    optimizeNearFar: (function () {
      var eye = [0.0, 0.0, 0.0];
      var tmp = [0.0, 0.0, 0.0];
      return function (bb) {
        if (!bb) bb = this.lastBBox_;
        if (!bb) return;
        this.lastBBox_ = bb;
        vec3.set(eye, this.trans_[0], this.trans_[1], this.getTransZ());
        var diag = vec3.dist(bb, vec3.set(tmp, bb[3], bb[4], bb[5]));
        var dist = vec3.dist(eye, vec3.set(tmp, (bb[0] + bb[3]) * 0.5, (bb[1] + bb[4]) * 0.5, (bb[2] + bb[5]) * 0.5));
        this.near_ = Math.max(0.01, dist - diag);
        this.far_ = diag + dist;
        this.updateProjection();
      };
    })(),
    updateProjection: function () {
      if (this.projType_ === Camera.projType.PERSPECTIVE) {
        mat4.perspective(this.proj_, this.fov_ * Math.PI / 180.0, this.width_ / this.height_, this.near_, this.far_);
        this.proj_[10] = -1.0;
        this.proj_[14] = -2 * this.near_;
      } else {
        this.updateOrtho();
      }
    },
    updateTranslation: function () {
      var trans = this.trans_;
      trans[0] += this.moveX_ * this.speed_ * trans[2] / 50 / 400.0;
      trans[2] = Math.max(0.00001, trans[2] + this.moveZ_ * this.speed_ / 400.0);
      if (this.projType_ === Camera.projType.ORTHOGRAPHIC)
        this.updateOrtho();
      this.updateView();
    },
    translate: function (dx, dy) {
      var factor = this.speed_ * this.trans_[2] / 50;
      this.trans_[0] -= dx * factor;
      this.trans_[1] += dy * factor;
      this.updateView();
    },
    zoom: function (delta) {
      var off = this.offset_;
      var factor = delta * this.speed_ / 54;
      this.trans_[0] += (off[0] - this.trans_[0]) * Math.max(factor, 0.0);
      this.trans_[1] += (off[1] - this.trans_[1]) * Math.max(factor, 0.0);
      this.trans_[2] += (off[2] - this.trans_[2]) * factor;

      if (this.projType_ === Camera.projType.ORTHOGRAPHIC)
        this.updateOrtho();
      this.updateView();
    },
    updateOrtho: function () {
      var delta = Math.abs(this.trans_[2]) * 0.00055;
      mat4.ortho(this.proj_, -this.width_ * delta, this.width_ * delta, -this.height_ * delta, this.height_ * delta, -this.near_, this.far_);
    },
    computePosition: function () {
      var view = this.view_;
      var pos = [-view[12], -view[13], -view[14]];
      var rot = mat3.create();
      mat3.fromMat4(rot, view);
      return vec3.transformMat3(pos, pos, mat3.transpose(rot, rot));
    },
    resetView: function () {
      this.rotX_ = this.rotY_ = 0.0;
      this.speed_ = Utils.SCALE * 0.9;
      quat.identity(this.quatRot_);
      vec3.set(this.center_, 0.0, 0.0, 0.0);
      vec3.set(this.offset_, 0.0, 0.0, 0.0);
      vec3.set(this.trans_, 0.0, 0.0, 30.0);
      this.zoom(-0.6);
    },
    resetViewFront: function () {
      this.rotX_ = this.rotY_ = 0.0;
      quat.set(this.quatRot_, 0, 0, 0, 1);
      this.updateView();
    },
    resetViewBack: function () {
      this.rotX_ = 0.0;
      this.rotY_ = Math.PI;
      quat.set(this.quatRot_, 0, 1, 0, 0);
      this.updateView();
    },
    resetViewTop: function () {
      this.rotX_ = Math.PI * 0.5;
      this.rotY_ = 0.0;
      quat.set(this.quatRot_, Math.SQRT1_2, 0, 0, Math.SQRT1_2);
      this.updateView();
    },
    resetViewBottom: function () {
      this.rotX_ = -Math.PI * 0.5;
      this.rotY_ = 0.0;
      quat.set(this.quatRot_, -Math.SQRT1_2, 0, 0, Math.SQRT1_2);
      this.updateView();
    },
    resetViewLeft: function () {
      this.rotX_ = 0.0;
      this.rotY_ = -Math.PI * 0.5;
      quat.set(this.quatRot_, 0, -Math.SQRT1_2, 0, Math.SQRT1_2);
      this.updateView();
    },
    resetViewRight: function () {
      this.rotX_ = 0.0;
      this.rotY_ = Math.PI * 0.5;
      quat.set(this.quatRot_, 0, Math.SQRT1_2, 0, Math.SQRT1_2);
      this.updateView();
    },
    toggleViewFront: function () {
      if (this.quatRot_[3] > 0.99) this.resetViewBack();
      else this.resetViewFront();
    },
    toggleViewTop: function () {
      var dot = this.quatRot_[0] * Math.SQRT1_2 + this.quatRot_[3] * Math.SQRT1_2;
      if (dot * dot > 0.99) this.resetViewBottom();
      else this.resetViewTop();
    },
    toggleViewLeft: function () {
      var dot = -this.quatRot_[1] * Math.SQRT1_2 + this.quatRot_[3] * Math.SQRT1_2;
      if (dot * dot > 0.99) this.resetViewRight();
      else this.resetViewLeft();
    },
    /** Project the mouse coordinate into the world coordinate at a given z */
    unproject: (function () {
      var mat = mat4.create();
      var n = [0.0, 0.0, 0.0, 1.0];
      return function (mouseX, mouseY, z) {
        var height = this.height_;
        n[0] = (2.0 * mouseX / this.width_) - 1.0;
        n[1] = (height - 2.0 * mouseY) / height;
        n[2] = 2.0 * z - 1.0;
        n[3] = 1.0;
        vec4.transformMat4(n, n, mat4.invert(mat, mat4.mul(mat, this.proj_, this.view_)));
        var w = n[3];
        return [n[0] / w, n[1] / w, n[2] / w];
      };
    })(),
    /** Project a vertex onto the screen */
    project: (function () {
      var vec = [0.0, 0.0, 0.0, 1.0];
      return function (vector) {
        vec[0] = vector[0];
        vec[1] = vector[1];
        vec[2] = vector[2];
        vec[3] = 1.0;
        vec4.transformMat4(vec, vec, this.view_);
        vec4.transformMat4(vec, vec, this.proj_);
        var w = vec[3];
        var height = this.height_;
        return [(vec[0] / w + 1) * this.width_ * 0.5, height - (vec[1] / w + 1.0) * height * 0.5, (vec[2] / w + 1.0) * 0.5];
      };
    })(),
    snapClosestRotation: (function () {
      var sq = Math.SQRT1_2;
      var d = 0.5;
      var qComp = [
        quat.fromValues(1, 0, 0, 0),
        quat.fromValues(0, 1, 0, 0),
        quat.fromValues(0, 0, 1, 0),
        quat.fromValues(0, 0, 0, 1),
        quat.fromValues(sq, sq, 0, 0),
        quat.fromValues(sq, -sq, 0, 0),
        quat.fromValues(sq, 0, sq, 0),
        quat.fromValues(sq, 0, -sq, 0),
        quat.fromValues(sq, 0, 0, sq),
        quat.fromValues(sq, 0, 0, -sq),
        quat.fromValues(0, sq, sq, 0),
        quat.fromValues(0, sq, -sq, 0),
        quat.fromValues(0, sq, 0, sq),
        quat.fromValues(0, sq, 0, -sq),
        quat.fromValues(0, 0, sq, sq),
        quat.fromValues(0, 0, sq, -sq),
        quat.fromValues(d, d, d, d),
        quat.fromValues(d, d, d, -d),
        quat.fromValues(d, d, -d, d),
        quat.fromValues(d, d, -d, -d),
        quat.fromValues(d, -d, d, d),
        quat.fromValues(d, -d, d, -d),
        quat.fromValues(d, -d, -d, d),
        quat.fromValues(-d, d, d, d),
      ];
      var nbQComp = qComp.length;
      return function () {
        // probably not the fastest way to do this thing :)
        var qrot = this.quatRot_;
        var min = 50;
        var id = 0;
        for (var i = 0; i < nbQComp; ++i) {
          var dot = quat.dot(qrot, qComp[i]);
          dot = 1 - dot * dot;
          if (min < dot)
            continue;
          min = dot;
          id = i;
        }
        quat.copy(qrot, qComp[id]);
        if (this.mode_ === Camera.mode.ORBIT) {
          var qx = qrot[3];
          var qy = qrot[1];
          var qz = qrot[2];
          var qw = qrot[0];
          // find back euler values
          this.rotY_ = Math.atan2(2 * (qx * qy + qz * qw), 1 - 2 * (qy * qy + qz * qz));
          this.rotX_ = Math.atan2(2 * (qx * qw + qy * qz), 1 - 2 * (qz * qz + qw * qw));
        }
        this.updateView();
      };
    })(),
    moveAnimationTo: function (x, y, z, main) {
      if (this.timer_)
        window.clearInterval(this.timer_);

      var duration = 1000;
      var trans = this.trans_;
      var delta = [x, y, z];
      vec3.sub(delta, delta, trans);
      var lastR = 0;

      var tStart = (new Date()).getTime();
      this.timer_ = window.setInterval(function () {
        var r = ((new Date()).getTime() - tStart) / duration;
        r = Math.min(1.0, r);
        // ease out quart
        r = r - 1;
        r = -(r * r * r * r - 1);

        var dr = r - lastR;
        lastR = r;
        vec3.scaleAndAdd(trans, trans, delta, dr);
        if (this.projType_ === Camera.projType.ORTHOGRAPHIC)
          this.updateOrtho();
        this.updateView();

        main.render();
        if (r >= 1.0)
          window.clearInterval(this.timer_);
      }.bind(this), 16.6);
    }
  };

  return Camera;
});