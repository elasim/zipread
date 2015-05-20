var fs = require("fs");
var path = require("path");
var assert = require("assert");
var zlib = require('zlib');

// Store original fs funcitons
var openSync = fs.openSync;
var closeSync = fs.closeSync;
var statSync = fs.statSync;
var readSync = fs.readSync;
var readAsync = fs.read;

var FH_SIZE = 30;
var FH_SIGN = 0x04034b50;
var EOCD_SIZE = 22;
var EOCD_SIGN = 0x06054b50;
var CDE_SIZE = 46;
var CDE_SIGN = 0x02014b50;

function Archive(path) {
    this.path = path;
    this.fd = openSync(path, "r");
    this.fileLen = statSync(path).size;
    this.files = {};

    var cd = this._getCD();
    var off = cd.offset;
    for (var i = 0; i < cd.records; i++) {
        off += this._readCDEntry(off);
    }
}

// We need those mostly for Windows
Archive.znorm = function(str) {
    return str.replace(/\\/g, "/");
};

Archive.zjoin = function(a, b) {
    return this.znorm(path.join(a, b));
};

Archive.prototype = {
    close: function() {
        closeSync(this.fd);
    },

    exists: function(path) {
        return path in this.files;
    },

    readFileSync: function(fname, encoding) {
        var file = this.files[fname];
        if (!file) {
            throw new Error("Path '" + fname + "' not found");
        }
        
        var hdr = new Buffer(FH_SIZE);
        this._readSync(hdr, file.offset);
        
        var dataOff = this._getDataOffset(file, hdr);
        var cbuf = new Buffer(file.csize);
       
        var read = this._readSync(cbuf, dataOff);
        assert.equal(read, cbuf.length);

        var result;
        if (file.method === 0) {
            result = cbuf;
        } else if (file.method === 8) {
            result = zlib.inflateRawSync(cbuf);
        } else {
            throw Error("Unsupported compression method " + file.method);
        }

        return encoding ? result.toString(encoding) : result;
    },

    readFile: function(fname, callback) {
        var file = this.files[fname];
        if (!file) {
            return callback(Error("Path '" + fname + "' not found"));
        }

        var hdr = new Buffer(FH_SIZE);
        var self = this;

        this._readAsync(hdr, file.offset, function () {
            var dataOff = self._getDataOffset(file, hdr);
            var cbuf = new Buffer(file.csize);

            self._readAsync(cbuf, dataOff, function (err, read) {
                assert.equal(read, cbuf.length);

                if (file.method === 0) {
                    callback(null, cbuf);
                } else if (file.method === 8) {
                    zlib.inflateRaw(cbuf, callback);
                }
            });
        });
    },

    filter: function(pred) {
        var result = [];

        for (var f in this.files) {
            var file = this.files[f];
            if (pred(f, file)) {
                result.push(file);
            }
        }

        return result;
    },

    readdir: function(dir) {
        dir = Archive.zjoin(dir, "/");
        var filtered = this.filter(function (relativePath, file) {
            var ss = relativePath.indexOf("/", dir.length);
            return relativePath.indexOf(dir) === 0
                && relativePath !== dir
                && (ss === -1 || ss == relativePath.length-1);
        });
        var found = filtered.map(function (file) {
            return path.basename(file.name);
        });
        return found;
    },

    _getDataOffset: function(file, hdr) {
        assert.equal(hdr.readUIntLE(0, 4), FH_SIGN, "Couldn't find file signature");

        var fnameLen = hdr.readUIntLE(26, 2);
        var extraLen = hdr.readUIntLE(28, 2);
        var dataOff = file.offset + hdr.length + fnameLen + extraLen;

        return dataOff;
    },

    _readSync: function(buf, position) {
        return readSync(this.fd, buf, 0, buf.length, position);
    },

    _readAsync: function(buf, position, callback) {
        return readAsync(this.fd, buf, 0, buf.length, position, callback);
    },

    _readCDEntry: function(offset) {
        var cde = new Buffer(CDE_SIZE);
        var read = this._readSync(cde, offset);
        assert.equal(read, cde.length);
        assert.equal(cde.readUIntLE(0, 4), CDE_SIGN, "Couldn't find CD signature");

        var fnameLen = cde.readUIntLE(28, 2);
        var extraLen = cde.readUIntLE(30, 2);
        var commentLen = cde.readUIntLE(32, 2);

        var fname = new Buffer(fnameLen);
        this._readSync(fname, offset + cde.length);

        var file = {
            name: fname.toString(),
            method: cde.readUIntLE(10, 2),
            csize: cde.readUIntLE(20, 4),
            usize: cde.readUIntLE(24, 4),
            offset: cde.readUIntLE(42, 4)
        };
        file.dir = file.csize === 0;

        this.files[file.name] = file;

        return cde.length + fnameLen + extraLen + commentLen;
    },

    _getCD: function() {
        // Find EOCD
        var eocd = new Buffer(EOCD_SIZE);
        this._readSync(eocd, this.fileLen - eocd.length);
        assert.equal(eocd.readUIntLE(0, 4), EOCD_SIGN, "Couldn't find EOCD signature");

        return {
            records: eocd.readUIntLE(10, 2),
            size: eocd.readUIntLE(12, 4),
            offset: eocd.readUIntLE(16, 4)
        };
    }
};

module.exports = Archive;