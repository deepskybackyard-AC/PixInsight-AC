#feature-id    Utilities > DonutSmoothing
#feature-info  Donut correction tool with internal preview, proportional zoom and pan
/*
 * Donut smoothing
 * Copyright: Andreas Cordt
 * Version: 1.0
 * Homepage: www.deepskyastrophoto.de
 */

#include <pjsr/Sizer.jsh>
#include <pjsr/StdButton.jsh>
#include <pjsr/NumericControl.jsh>

var PREVIEW_MIN_W = 1920;
var PREVIEW_MIN_H = 1200;

function clamp01( x )
{
   return x < 0 ? 0 : x > 1 ? 1 : x;
}

function makeExpression( x, y )
{
   return "iif($T < " + x.toFixed( 6 ) + ", " + y.toFixed( 6 ) + ", $T)";
}

function applyPixelMathToView( view, x, y )
{
   var P = new PixelMath;
   P.expression = makeExpression( x, y );
   P.useSingleExpression = true;
   P.createNewImage = false;
   P.rescale = false;
   P.truncate = true;
   P.executeOn( view );
}

function cloneWindow( sourceWindow, suffix )
{
   var img = sourceWindow.mainView.image;
   var id = sourceWindow.mainView.id + suffix;
   id = id.replace( /[^A-Za-z0-9_]/g, "_" );

   var W = new ImageWindow(
      img.width,
      img.height,
      img.numberOfChannels,
      img.bitsPerSample,
      img.isReal,
      img.isColor,
      id
   );

   W.mainView.beginProcess();
   W.mainView.image.assign( img );
   W.mainView.endProcess();

   return W;
}

function sortedCopy( a )
{
   var b = [];
   for ( var i = 0; i < a.length; ++i )
      b.push( a[i] );

   b.sort( function( u, v ){ return u-v; } );
   return b;
}

function medianOfSorted( a )
{
   if ( a.length == 0 )
      return 0;

   var n = a.length;
   var i = Math.floor( n/2 );

   if ( n & 1 )
      return a[i];

   return 0.5*( a[i-1] + a[i] );
}

function mtf( m, x )
{
   if ( x <= 0 )
      return 0;
   if ( x >= 1 )
      return 1;

   return ((m - 1)*x) / (((2*m - 1)*x) - m);
}

function findMidtonesBalance( x, y )
{
   if ( x <= 0 || x >= 1 )
      return 0.5;

   var m = x*(y - 1) / (2*x*y - y - x);

   if ( m <= 0 || m >= 1 )
      m = 0.5;

   return m;
}

function PanSlider( parent, vertical )
{
   this.__base__ = Control;
   this.__base__( parent );

   this.vertical = vertical;
   this.minValue = -2000;
   this.maxValue = 2000;
   this.value = 0;
   this.dragging = false;
   this.onValueChanged = null;

   if ( vertical )
   {
      this.setMinSize( 18, PREVIEW_MIN_H );
      this.setMaxWidth( 18 );
   }
   else
   {
      this.setMinSize( PREVIEW_MIN_W, 18 );
      this.setMaxHeight( 18 );
   }

   this.setValue = function( v )
   {
      if ( v < this.minValue ) v = this.minValue;
      if ( v > this.maxValue ) v = this.maxValue;
      this.value = v;
      this.update();
   };

   this.valueToPos = function()
   {
      var t = ( this.value - this.minValue ) / ( this.maxValue - this.minValue );

      if ( this.vertical )
         return Math.round( (1-t) * (this.height-18) ) + 9;

      return Math.round( t * (this.width-18) ) + 9;
   };

   this.posToValue = function( x, y )
   {
      var t;

      if ( this.vertical )
         t = 1 - (y-9)/(this.height-18);
      else
         t = (x-9)/(this.width-18);

      t = clamp01( t );
      return this.minValue + t*(this.maxValue-this.minValue);
   };

   this.updateFromMouse = function( x, y )
   {
      this.setValue( this.posToValue( x, y ) );

      if ( this.onValueChanged != null )
         this.onValueChanged( this.value );
   };

   this.onPaint = function()
   {
      var g = new Graphics( this );
      g.fillRect( this.boundsRect, new Brush( 0xffd0d0d0 ) );

      var p = this.valueToPos();

      if ( this.vertical )
      {
         g.fillRect( new Rect( 7, 4, 11, this.height-4 ), new Brush( 0xff909090 ) );
         g.fillRect( new Rect( 2, p-18, this.width-2, p+18 ), new Brush( 0xffeeeeee ) );
      }
      else
      {
         g.fillRect( new Rect( 4, 7, this.width-4, 11 ), new Brush( 0xff909090 ) );
         g.fillRect( new Rect( p-18, 2, p+18, this.height-2 ), new Brush( 0xffeeeeee ) );
      }

      g.end();
   };

   this.onMousePress = function( x, y )
   {
      this.dragging = true;
      this.updateFromMouse( x, y );
   };

   this.onMouseMove = function( x, y )
   {
      if ( this.dragging )
         this.updateFromMouse( x, y );
   };

   this.onMouseRelease = function()
   {
      this.dragging = false;
   };
}

PanSlider.prototype = new Control;

function PreviewControl( parent )
{
   this.__base__ = Control;
   this.__base__( parent );

   this.setMinSize( PREVIEW_MIN_W, PREVIEW_MIN_H );
   this.backgroundColor = 0xff202020;

   this.imageWindow = null;
   this.viewportBitmap = null;

   this.data = [];
   this.pw = 0;
   this.ph = 0;

   this.xValue = 0.000250;
   this.yValue = 0.000250;
   this.showOriginal = false;
   this.autoSTF = false;

   this.zoom = 1.0;
   this.offsetX = 0;
   this.offsetY = 0;

   this.dragging = false;
   this.lastX = 0;
   this.lastY = 0;

   this.previewMaxSize = 1200;
   this.onPanChanged = null;

   this.setImageWindow = function( W )
   {
      this.imageWindow = W;
      this.zoom = 1.0;
      this.offsetX = 0;
      this.offsetY = 0;
      this.buildPreviewData();
      this.renderViewport();

      if ( this.onPanChanged != null )
         this.onPanChanged( this.offsetX, this.offsetY );
   };

   this.setXValue = function( v )
   {
      this.xValue = v;
      this.buildPreviewData();
      this.renderViewport();
   };

   this.setYValue = function( v )
   {
      this.yValue = v;
      this.buildPreviewData();
      this.renderViewport();
   };

   this.setAutoSTF = function( enabled )
   {
      this.autoSTF = enabled ? true : false;
      this.buildPreviewData();
      this.renderViewport();
   };

   this.setPan = function( x, y )
   {
      this.offsetX = x;
      this.offsetY = y;
      this.renderViewport();
   };

   this.toggleOriginalPreview = function()
   {
      this.showOriginal = !this.showOriginal;
      this.buildPreviewData();
      this.renderViewport();
   };

   this.fitToWindow = function()
   {
      this.zoom = 1.0;
      this.offsetX = 0;
      this.offsetY = 0;

      if ( this.onPanChanged != null )
         this.onPanChanged( this.offsetX, this.offsetY );

      this.renderViewport();
   };

   this.buildPreviewData = function()
   {
      if ( this.imageWindow == null || this.imageWindow.isNull )
         return;

      var src = this.imageWindow.mainView.image;
      var sw = src.width;
      var sh = src.height;

      var scale = Math.max( sw, sh ) / this.previewMaxSize;
      if ( scale < 1 )
         scale = 1;

      this.pw = Math.floor( sw / scale );
      this.ph = Math.floor( sh / scale );

      var raw = [];

      for ( var yy = 0; yy < this.ph; ++yy )
      {
         var sy = Math.min( sh-1, Math.floor( yy*scale ) );

         for ( var xx = 0; xx < this.pw; ++xx )
         {
            var sx = Math.min( sw-1, Math.floor( xx*scale ) );
            var v = src.sample( sx, sy, 0 );

            if ( !this.showOriginal && v < this.xValue )
               v = this.yValue;

            raw.push( v );
         }
      }

      var black = 0;
      var white = 1;
      var midtones = 0.5;

      if ( this.autoSTF )
      {
         var sorted = sortedCopy( raw );
         var med = medianOfSorted( sorted );

         var dev = [];
         for ( var d = 0; d < raw.length; ++d )
            dev.push( Math.abs( raw[d] - med ) );

         var mad = medianOfSorted( sortedCopy( dev ) );

         var shadowsClipping = -2.8;
         var targetBackground = 0.25;

         black = med + shadowsClipping * 1.4826 * mad;

         if ( mad <= 1.0e-10 || black >= med )
            black = 0;

         if ( black < 0 )
            black = 0;

         white = 1;

         var mInput = ( med - black ) / ( white - black );

         if ( mInput <= 0 )
            mInput = med;

         midtones = findMidtonesBalance( mInput, targetBackground );
      }

      this.data = [];

      for ( var i = 0; i < raw.length; ++i )
      {
         var v2 = raw[i];

         if ( this.autoSTF )
         {
            v2 = ( v2 - black ) / ( white - black );
            v2 = clamp01( v2 );
            v2 = mtf( midtones, v2 );
         }

         this.data.push( clamp01( v2 ) );
      }
   };

   this.renderViewport = function()
   {
      if ( this.data.length == 0 )
         return;

      var vw = this.width;
      var vh = this.height;

      var img = new Image( vw, vh, 1 );
      img.fill( 0 );

      var cx = vw / 2;
      var cy = vh / 2;

      var sxCenter = this.pw / 2;
      var syCenter = this.ph / 2;

      for ( var y = 0; y < vh; ++y )
      {
         var sy = Math.floor( syCenter + ( y - cy - this.offsetY ) / this.zoom );

         if ( sy < 0 || sy >= this.ph )
            continue;

         for ( var x = 0; x < vw; ++x )
         {
            var sx = Math.floor( sxCenter + ( x - cx - this.offsetX ) / this.zoom );

            if ( sx < 0 || sx >= this.pw )
               continue;

            img.setSample( this.data[ sy*this.pw + sx ], x, y, 0 );
         }
      }

      this.viewportBitmap = img.render();
      this.update();
   };

   this.onResize = function()
   {
      this.renderViewport();
   };

   this.onPaint = function()
   {
      var g = new Graphics( this );
      g.fillRect( this.boundsRect, new Brush( 0xff202020 ) );

      if ( this.viewportBitmap != null )
         g.drawBitmap( 0, 0, this.viewportBitmap );

      g.end();
   };

   this.onMousePress = function( x, y )
   {
      this.dragging = true;
      this.lastX = x;
      this.lastY = y;
   };

   this.onMouseMove = function( x, y )
   {
      if ( this.dragging )
      {
         this.offsetX += x - this.lastX;
         this.offsetY += y - this.lastY;

         this.lastX = x;
         this.lastY = y;

         if ( this.onPanChanged != null )
            this.onPanChanged( this.offsetX, this.offsetY );

         this.renderViewport();
      }
   };

   this.onMouseRelease = function()
   {
      this.dragging = false;
   };

   this.onMouseWheel = function( x, y, delta )
   {
      if ( delta > 0 )
         this.zoom *= 1.20;
      else
         this.zoom /= 1.20;

      if ( this.zoom < 0.2 )
         this.zoom = 0.2;

      if ( this.zoom > 30 )
         this.zoom = 30;

      this.renderViewport();
   };
}

PreviewControl.prototype = new Control;

function DonutSmoothingDialog()
{
   this.__base__ = Dialog;
   this.__base__();

   var self = this;

   this.windowTitle = "Donut smoothing";

   this.originalWindow = null;
   this.xValue = 0.000250;
   this.yValue = 0.000250;

   this.preview = new PreviewControl( this );
   this.hSlider = new PanSlider( this, false );
   this.vSlider = new PanSlider( this, true );

   this.openButton = new PushButton( this );
   this.openButton.text = "Bild auswählen und laden";

   this.useActiveButton = new PushButton( this );
   this.useActiveButton.text = "Aktives Bild verwenden";

   this.xControl = new NumericControl( this );
   this.xControl.label.text = "Schwellenwert x";
   this.xControl.setRange( 0.000000, 0.010000 );
   this.xControl.slider.setRange( 0, 10000 );
   this.xControl.setPrecision( 6 );
   this.xControl.setValue( this.xValue );

   this.yControl = new NumericControl( this );
   this.yControl.label.text = "Zielwert y";
   this.yControl.setRange( 0.000000, 0.010000 );
   this.yControl.slider.setRange( 0, 10000 );
   this.yControl.setPrecision( 6 );
   this.yControl.setValue( this.yValue );

   this.autoSTFCheckBox = new CheckBox( this );
   this.autoSTFCheckBox.text = "Auto STF für Vorschau aktivieren";
   this.autoSTFCheckBox.checked = false;

   this.toggleButton = new PushButton( this );
   this.toggleButton.text = "Original / Vorschau umschalten";
   this.toggleButton.enabled = false;

   this.fitButton = new PushButton( this );
   this.fitButton.text = "Ansicht einpassen";
   this.fitButton.enabled = false;

   this.saveButton = new PushButton( this );
   this.saveButton.text = "Änderung als neues Bild erzeugen";
   this.saveButton.enabled = false;

   this.closeButton = new PushButton( this );
   this.closeButton.text = "Schließen";

   this.statusLabel = new Label( this );
   this.statusLabel.text = "Kein Bild geladen.";

   this.copyrightLabel = new Label( this );
   this.copyrightLabel.text =
   "© Andreas Cordt · Version 1.0 · www.deepskyastrophoto.de";
   this.preview.onPanChanged = function( x, y )
   {
      self.hSlider.setValue( x );
      self.vSlider.setValue( y );
   };

   this.hSlider.onValueChanged = function( v )
   {
      self.preview.setPan( v, self.preview.offsetY );
   };

   this.vSlider.onValueChanged = function( v )
   {
      self.preview.setPan( self.preview.offsetX, v );
   };

   this.prepareImage = function( W )
   {
      self.originalWindow = W;
      self.toggleButton.enabled = true;
      self.fitButton.enabled = true;
      self.saveButton.enabled = true;

      self.statusLabel.text =
         "Bild geladen: " + W.mainView.id + " — Vorschau wird berechnet ...";

      try
      {
         self.preview.setImageWindow( W );
         self.statusLabel.text =
            "Bild geladen: " + W.mainView.id +
            "   |   Mausrad = proportionaler Zoom, Mausziehen / Slider = Verschieben";
      }
      catch ( e )
      {
         self.statusLabel.text =
            "Bild geladen, aber Vorschau konnte nicht berechnet werden.";
         console.writeln( "<end><cbr><br>Fehler bei Vorschau:" );
         console.writeln( e );
      }
   };

   this.openButton.onClick = function()
   {
      var ofd = new OpenFileDialog;
      ofd.caption = "Bild öffnen";
      ofd.filters = [
         [ "PixInsight XISF", "*.xisf" ],
         [ "FITS", "*.fit", "*.fits" ],
         [ "TIFF", "*.tif", "*.tiff" ],
         [ "Alle Dateien", "*" ]
      ];

      if ( !ofd.execute() )
         return;

      var opened = ImageWindow.open( ofd.fileName );
      var W = null;

      if ( opened instanceof Array )
      {
         if ( opened.length > 0 )
            W = opened[0];
      }
      else
         W = opened;

      if ( W == null || W.isNull )
         W = ImageWindow.activeWindow;

      if ( W == null || W.isNull )
      {
         new MessageBox( "Das Bild konnte nicht übernommen werden.", "Fehler", StdIcon_Error ).execute();
         return;
      }

      self.prepareImage( W );
   };

   this.useActiveButton.onClick = function()
   {
      var W = ImageWindow.activeWindow;

      if ( W == null || W.isNull )
      {
         new MessageBox( "Es ist kein aktives Bild vorhanden.", "Hinweis", StdIcon_Warning ).execute();
         return;
      }

      self.prepareImage( W );
   };

   this.xControl.onValueUpdated = function( value )
   {
      self.xValue = value;

      if ( self.originalWindow != null && !self.originalWindow.isNull )
         self.preview.setXValue( value );
   };

   this.yControl.onValueUpdated = function( value )
   {
      self.yValue = value;

      if ( self.originalWindow != null && !self.originalWindow.isNull )
         self.preview.setYValue( value );
   };

   this.autoSTFCheckBox.onCheck = function()
   {
      if ( self.originalWindow != null && !self.originalWindow.isNull )
         self.preview.setAutoSTF( self.autoSTFCheckBox.checked );
   };

   this.toggleButton.onClick = function()
   {
      self.preview.toggleOriginalPreview();
      self.statusLabel.text =
         self.preview.showOriginal ? "Anzeige: Original" : "Anzeige: korrigierte Vorschau";
   };

   this.fitButton.onClick = function()
   {
      self.preview.fitToWindow();
   };

   this.saveButton.onClick = function()
   {
      if ( self.originalWindow == null || self.originalWindow.isNull )
         return;

      try
      {
         var resultWindow = cloneWindow( self.originalWindow, "_DonutCorrected" );
         applyPixelMathToView( resultWindow.mainView, self.xValue, self.yValue );

         resultWindow.show();
         resultWindow.bringToFront();

         self.statusLabel.text =
            "Korrigiertes Bild wurde als neues Bildfenster erzeugt. Formel: " +
            makeExpression( self.xValue, self.yValue );
      }
      catch ( e )
      {
         self.statusLabel.text = "Fehler beim Erzeugen des korrigierten Bildes.";
         console.writeln( "<end><cbr><br>Fehler beim Erzeugen:" );
         console.writeln( e );
      }
   };

   this.closeButton.onClick = function()
   {
      self.cancel();
   };

   var topSizer = new HorizontalSizer;
   topSizer.spacing = 6;
   topSizer.add( this.openButton );
   topSizer.add( this.useActiveButton );

   var actionSizer = new HorizontalSizer;
   actionSizer.spacing = 6;
   actionSizer.add( this.toggleButton );
   actionSizer.add( this.fitButton );
   actionSizer.add( this.saveButton );

   var previewRow = new HorizontalSizer;
   previewRow.spacing = 4;
   previewRow.add( this.preview, 100 );
   previewRow.add( this.vSlider );

   this.sizer = new VerticalSizer;
   this.sizer.margin = 8;
   this.sizer.spacing = 6;

   this.sizer.add( topSizer );
   this.sizer.add( this.xControl );
   this.sizer.add( this.yControl );
   this.sizer.add( this.autoSTFCheckBox );
   this.sizer.add( actionSizer );
   this.sizer.add( previewRow, 100 );
   this.sizer.add( this.hSlider );
   this.sizer.add( this.statusLabel );
   this.sizer.add( this.copyrightLabel );
   this.sizer.add( this.closeButton );
   this.copyrightLabel = new Label( this );
   this.copyrightLabel.useRichText = true;
   this.copyrightLabel.text =
	   "<small>© Andreas Cordt · Version 1.0 · www.deepskyastrophoto.de</small>";
   this.sizer.add( this.closeButton );

   this.adjustToContents();
   this.setVariableSize();
   this.userResizable = true;
}

DonutSmoothingDialog.prototype = new Dialog;

var dialog = new DonutSmoothingDialog;
dialog.execute();