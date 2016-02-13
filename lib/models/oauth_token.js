'use strict';
const IN_PAYLOAD = ['kind', 'jti', 'nonce'];
const IN_HEADER = [
  'accountId',
  'clientId',
  'authTime',
  'redirectUri',
  'claims',
  'grantId',
  'acr',
  'scope'
];
const IS_MANDATORY = ['exp', 'iat', 'iss', 'jti', 'kind'];

let _ = require('lodash');
let base64url = require('base64url');
let assert = require('assert');
let uuid = require('node-uuid');

let errors = require('../helpers/errors');
let JWT = require('../helpers/jwt');

module.exports = function(provider) {

  return class OAuthToken {

    constructor(payload) {
      Object.assign(this, payload);

      this.jti = this.jti || uuid.v4();

      this.kind = this.kind || this.constructor.name;
      assert.equal(this.kind, this.constructor.name, 'kind mismatch');
      // assert.ok(this.scope, 'scope must be present');
    }

    static get adapter() {
      let conf = provider.configuration;
      if (!this._adapter) {
        this._adapter = new conf.adapters[conf.adapter](this.name);
      }
      return this._adapter;
    }

    get adapter() {
      return this.constructor.adapter;
    }

    static get expiresIn() {
      if (!this.ttl) {
        throw 'expiresIn not set';
      }
      return this.ttl;
    }

    static set expiresIn(ttl) {
      this.ttl = ttl;
    }

    get standardPayload() {
      return IN_PAYLOAD;
    }

    get headerPayload() {
      return IN_HEADER;
    }

    get isValid() {
      // TODO: consumed should not be forced as a property
      return !this.consumed && !this.isExpired;
    }

    get isExpired() {
      return this.exp <= Date.now() / 1000 | 0;
    }

    toJWT() {
      if (!this.jwt) {

        let key = provider.keystore.get({
          alg: 'RS256',
          use: 'sig',
        });

        let deferred = Promise.defer();

        JWT.sign(_.pick(this, this.standardPayload), key, 'RS256', {
          expiresIn: this.constructor.expiresIn,
          headers: _.pick(this, this.headerPayload),
          issuer: provider.issuer,
        }).then((jwt) => {
          let parts = jwt.split('.');

          this.jwt = jwt;
          this.token = parts[1] + '.' + parts[2];


          this.adapter.upsert(this.jti, {
            grantId: this.grantId,
            header: parts[0],
            payload: parts[1],
            signature: parts[2],
          }, this.constructor.expiresIn).then(() => {

            provider.emit('token.issued', this);

            deferred.resolve(this.jwt);
          }, (err) => {
            deferred.reject(err);
          });
        });


        return deferred.promise;
      }

      return Promise.resolve(this.jwt);
    }

    toToken() {
      if (!this.jwt) {
        return this.toJWT().then(() => this.token);
      }

      return Promise.resolve(this.token);
    }

    destroy() {

      provider.emit('token.revoked', this);
      provider.emit('grant.revoked', this.grantId);

      return this.adapter.destroy(this.jti);
    }

    consume() {
      provider.emit('token.consumed', this);
      return this.adapter.consume(this.jti);
    }

    static fromJWT(jwt, opts) {
      opts = opts || {};
      opts.ignoreExpiration =
        'ignoreExpiration' in opts ? opts.ignoreExpiration : false;
      opts.issuer = provider.issuer;

      return JWT.verify(jwt, provider.keystore, opts).then((result) => {
        return new this(Object.assign(result.payload, result.header));
      });
    }

    static decode(wildToken) {
      try {
        let parts = wildToken.split('.');
        assert(parts.length === 2, 'token consists of two parts');

        let decoded = JSON.parse(base64url.decode(parts[0]));

        IS_MANDATORY.forEach((prop) => {
          assert.ok(decoded[prop] !== undefined,
            `token missing payload property (${prop})`);
          assert.ok(decoded[prop],
            `token payload property invalid (${decoded[prop]})`);
        });

        return {
          payload: decoded,
          raw: parts[0],
          signature: parts[1],
        };

      } catch (err) {
        throw new errors.InvalidTokenError();
      }
    }

    static find(wildToken, opts) {
      opts = opts || {};
      opts.ignoreExpiration =
        'ignoreExpiration' in opts ? opts.ignoreExpiration : false;

      let decoded;

      try {
        decoded = this.decode(wildToken);
      } catch (err) {
        return Promise.reject(err);
      }

      let deferred = Promise.defer();

      this.adapter.find(decoded.payload.jti).then((token) => {
        if (token) {
          let jwt = [token.header, decoded.raw, decoded.signature].join('.');

          let expected = [
            token.header, token.payload, token.signature
          ].join('.');

          if (jwt !== expected) {
            return deferred.reject(new errors.InvalidTokenError());
          }

          this.fromJWT(jwt, opts).then((validated) => {
            if (token.consumed !== undefined) {
              validated.consumed = token.consumed;
            }
            deferred.resolve(validated);
          }).catch(() => {
            deferred.reject(new errors.InvalidTokenError());
          });

        } else {
          return deferred.resolve();
        }
      }, (err) => {
        return deferred.reject(err);
      });

      return deferred.promise;
    }
  };
};